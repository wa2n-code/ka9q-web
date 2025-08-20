//
// Web interface for ka9q-radio
//
// Uses Onion Web Framework (https://github.com/davidmoreno/onion)
//
// John Melton G0ORX (N6LYT)
//
// Beware this is a very early test version
//
// Copyright 2023-2024, John Melton, G0ORX
//

#define _GNU_SOURCE 1

#include <onion/log.h>
#include <onion/onion.h>
#include <onion/dict.h>
#include <onion/sessions.h>
#include <onion/websocket.h>
#include <string.h>
#include <errno.h>
#include <getopt.h>
#include <pthread.h>
#include <unistd.h>
#include <ctype.h>
#include <sysexits.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
//#include <stdlib.h>
#include <bsd/stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>

#include "misc.h"
#include "multicast.h"
#include "status.h"
#include "radio.h"
#include "config.h"

const char *webserver_version = "2.76";

// no handlers in /usr/local/include??
onion_handler *onion_handler_export_local_new(const char *localpath);

int Ctl_fd,Input_fd,Status_fd;
pthread_mutex_t ctl_mutex;
pthread_t ctrl_task;
pthread_t audio_task;
pthread_mutex_t output_dest_socket_mutex;
pthread_cond_t output_dest_socket_cond;

struct session {
  bool spectrum_active;
  bool audio_active;
  onion_websocket *ws;
  pthread_mutex_t ws_mutex;
  uint32_t ssrc;
  pthread_t poll_task;
  pthread_t spectrum_task;
  pthread_mutex_t spectrum_mutex;
  uint32_t center_frequency;
  uint32_t frequency;           // tuned frequency, in Hz
  uint32_t bin_width;
  float tc;
  int bins;
  char description[128];
  char client[128];
  struct session *next;
  struct session *previous;
  bool once;
  float if_power;
  float noise_density_audio;
  int zoom_index;
  char requested_preset[32];
  float bins_min_db;
  float bins_max_db;
  float bins_autorange_gain;
  float bins_autorange_offset;
  /* uint32_t last_poll_tag; */
};

#define START_SESSION_ID 1000

int init_connections(const char *multicast_group);
extern int init_control(struct session *sp);
extern void control_set_frequency(struct session *sp,char *str);
extern void control_set_mode(struct session *sp,char *str);
int init_demod(struct channel *channel);
void control_get_powers(struct session *sp,float frequency,int bins,float bin_bw);
void stop_spectrum_stream(struct session *sp);
int extract_powers(float *power,int npower,uint64_t *time,double *freq,double *bin_bw,int32_t const ssrc,uint8_t const * const buffer,int length,struct session *sp);
void control_poll(struct session *sp);
void *spectrum_thread(void *arg);
void *ctrl_thread(void *arg);

struct frontend Frontend;
struct sockaddr Metadata_source_socket;       // Source of metadata
struct sockaddr Metadata_dest_socket;         // Dest of metadata (typically multicast)

static int const DEFAULT_IP_TOS = 48;
static int const DEFAULT_MCAST_TTL = 1;

uint64_t Metadata_packets;
struct channel Channel;
uint64_t Block_drops;
int Mcast_ttl = DEFAULT_MCAST_TTL;
int IP_tos = DEFAULT_IP_TOS;
const char *App_path;
int64_t Timeout = BILLION;
uint16_t rtp_seq=0;
int verbose = 0;
int bin_precision_bytes = 4;    // number of bytes/bin over the websocket connection
/* static int error_count = 0; */
/* static int ok_count = 0; */

#define MAX_BINS 1620

onion_connection_status websocket_cb(void *data, onion_websocket * ws,
                                               ssize_t data_ready_len);

onion_connection_status audio_source(void *data, onion_request * req,
                                          onion_response * res);
onion_connection_status stream_audio(void *data, onion_request * req,
                                          onion_response * res);
static void *audio_thread(void *arg);
onion_connection_status home(void *data, onion_request * req,
                                          onion_response * res);
onion_connection_status status(void *data, onion_request * req,
                                          onion_response * res);
onion_connection_status version(void *data, onion_request * req,
                                          onion_response * res);

pthread_mutex_t session_mutex;
static int nsessions=0;
static struct session *sessions=NULL;

char const *description_override=0;
bool run_with_realtime = false;

void add_session(struct session *sp) {
  pthread_mutex_lock(&session_mutex);
  if(sessions==NULL) {
    sessions=sp;
  } else {
    sessions->previous=sp;
    sp->next=sessions;
    sessions=sp;
  }
  nsessions++;
  pthread_mutex_unlock(&session_mutex);
//fprintf(stderr,"%s: ssrc=%d first=%p ws=%p nsessions=%d\n",__FUNCTION__,sp->ssrc,sessions,sp->ws,nsessions);
}

void delete_session(struct session *sp) {
//fprintf(stderr,"%s: sp=%p src=%d ws=%p\n",__FUNCTION__,sp,sp->ssrc,sp->ws);
  if(sp->next!=NULL) {
    sp->next->previous=sp->previous;
  }
  if(sp->previous!=NULL) {
    sp->previous->next=sp->next;
  }
  if(sessions==sp) {
    sessions=sp->next;
  }
  nsessions--;
//fprintf(stderr,"%s: sp=%p ssrc=%d first=%p ws=%p nsessions=%d\n",__FUNCTION__,sp,sp->ssrc,sessions,sp->ws,nsessions);
  free(sp);
  pthread_mutex_unlock(&session_mutex);
}

// Note that this locks the session_mutex *if* it finds a session
static struct session *find_session_from_websocket(onion_websocket *ws) {
  pthread_mutex_lock(&session_mutex);
//fprintf(stderr,"%s: first=%p ws=%p\n",__FUNCTION__,sessions,ws);
  struct session *sp=sessions;
  while(sp!=NULL) {
    if(sp->ws==ws) {
      break;
    }
    sp=sp->next;
  }
//fprintf(stderr,"%s: ws=%p sp=%p\n",__FUNCTION__,ws,sp);
  if (sp == NULL) {
    pthread_mutex_unlock(&session_mutex);
  }
  return sp;
}

// Note that this locks the session_mutex *if* it finds a session
static struct session *find_session_from_ssrc(int ssrc) {
  pthread_mutex_lock(&session_mutex);
//fprintf(stderr,"%s: first=%p ssrc=%d\n",__FUNCTION__,sessions,ssrc);
  struct session *sp=sessions;
  while(sp!=NULL) {
    if(sp->ssrc==ssrc) {
      break;
    }
    sp=sp->next;
  }
//fprintf(stderr,"%s: ssrc=%d sp=%p\n",__FUNCTION__,ssrc,sp);
  if (sp == NULL) {
    pthread_mutex_unlock(&session_mutex);
  }
  return sp;
}

void websocket_closed(struct session *sp) {
  if (verbose)
    fprintf(stderr,"%s(): SSRC=%d audio_active=%d spectrum_active=%d\n",__FUNCTION__,sp->ssrc,sp->audio_active,sp->spectrum_active);

  pthread_mutex_lock(&sp->ws_mutex);
  control_set_frequency(sp,"0");
  sp->audio_active=false;
  if(sp->spectrum_active) {
    pthread_mutex_lock(&sp->spectrum_mutex);
    sp->spectrum_active=false;
    stop_spectrum_stream(sp);
    pthread_mutex_unlock(&sp->spectrum_mutex);
    pthread_join(sp->spectrum_task,NULL);
  }
  pthread_mutex_unlock(&sp->ws_mutex);
}

static void check_frequency(struct session *sp) {
    int64_t span = (int64_t)sp->bin_width * sp->bins;
    int64_t center_freq = (int64_t)sp->center_frequency;
    int64_t min_f = center_freq - (span / 2);
    int64_t max_f = center_freq + (span / 2);

    int freq_bin = ((int64_t)sp->frequency - min_f) / sp->bin_width;

    int64_t fs2 = Frontend.samprate / 2;
    if (freq_bin >= sp->bins) {
        int64_t target_bin = sp->bins - 30;
        int64_t new_min_f = (int64_t)sp->frequency - target_bin * sp->bin_width;
        int64_t new_center = new_min_f + (span / 2);
        int64_t new_max_f = new_center + (span / 2);
        if (new_max_f > fs2) {
            new_center = fs2 - (span / 2);
            new_min_f = new_center - (span / 2);
        }
        center_freq = new_center;
        min_f = center_freq - (span / 2);
        max_f = center_freq + (span / 2);
        freq_bin = (sp->frequency - min_f) / sp->bin_width;
    } else if (freq_bin < 0) {
        center_freq = (int64_t)sp->frequency - 30 * sp->bin_width;
        min_f = center_freq - (span / 2);
        max_f = center_freq + (span / 2);
        freq_bin = (sp->frequency - min_f) / sp->bin_width;
    }

    if (min_f < 0) {
        center_freq = 0 + (span / 2);
    } else if (max_f > fs2) {
        center_freq = fs2 - (span / 2);
    }

    // Final recompute after any adjustments
    min_f = center_freq - (span / 2);
    max_f = center_freq + (span / 2);

    sp->center_frequency = (uint32_t)center_freq;

    // Only log if the tuned frequency is outside the visible range after all adjustments
    if (((int64_t)sp->frequency > max_f) || ((int64_t)sp->frequency < min_f)) {
        int freq_bin_final = ((int64_t)sp->frequency - min_f) / sp->bin_width;
        printf("[check_frequency] Final: tuned freq %u is at bin %d (outside visible range [0-%d])\n", 
               sp->frequency/1000, freq_bin_final, sp->bins-1);
    }
}

struct zoom_table_t {
  int bin_width;
  int bin_count;
};

const struct zoom_table_t zoom_table[] = {
  {40000, 1620},
  {20000, 1620},
  {16000, 1620},
  {8000, 1620},
  {4000, 1620},
  {2000, 1620},
  {1000, 1620},
  {800, 1620},
  {400, 1620},
  {200, 1620},
  {120, 1620},
  {80, 1620},
  {40, 1620},
  {20, 1620},
  {10, 1620},
  {5, 1620},
  {2, 1620},
  {1, 1620}
};

static void zoom_to(struct session *sp, int level) {
  const int table_size = sizeof(zoom_table) / sizeof(zoom_table[0]);
  sp->zoom_index = level;
  if (sp->zoom_index >= table_size)
    sp->zoom_index = table_size-1;

  if (sp->zoom_index < 0)
    sp->zoom_index = 0;

  if ((Frontend.samprate <= 64800000) && (sp->zoom_index <= 0))
    sp->zoom_index = 1;
  sp->bin_width = zoom_table[sp->zoom_index].bin_width;
  sp->bins = zoom_table[sp->zoom_index].bin_count;
}

static void zoom(struct session *sp, int shift) {
  zoom_to(sp,sp->zoom_index+shift);
}

/* Clamp center frequency so the visible span stays within [0, fs/2]
   but do not force the tuned frequency to be inside the visible window. */
static void adjust_center_within_bounds(struct session *sp) {
  int64_t span = (int64_t)sp->bin_width * sp->bins;
  int64_t center_freq = (int64_t)sp->center_frequency;
  int64_t fs2 = Frontend.samprate / 2;
  if (span >= (fs2 * 2)) {
    /* span covers full range; center must be clamped to middle */
    center_freq = fs2;
  } else {
    int64_t half = span / 2;
    if (center_freq - half < 0) {
      center_freq = half;
    } else if (center_freq + half > fs2) {
      center_freq = fs2 - half;
    }
  }
  sp->center_frequency = (uint32_t)center_freq;
}

/*
The `websocket_cb` function is the central callback for handling all WebSocket communication between the web client 
and the SDR server. It is invoked whenever a message is received from a client or when the connection state changes. 
This function is responsible for interpreting client commands, managing per-client session state, and coordinating the 
creation and control of background threads for spectrum and audio streaming.

At the start, the function locates the session associated with the incoming WebSocket connection. If the connection is 
closing or the client has disconnected, it performs cleanup by stopping any active threads, releasing resources, and 
removing the session from the global list.

When a message is received, the function reads and parses the command, which may request actions such as starting or 
stopping spectrum or audio streaming, changing the frequency, adjusting the demodulator mode, or modifying the spectrum 
zoom level. Each command is processed by updating the session state, sending control commands to the radio backend, 
or starting/stopping per-session threads as needed. For example, a spectrum start command will launch a 
dedicated spectrum thread for that client, while a frequency change will update the session’s frequency and 
notify the backend.

The function uses mutexes to ensure thread-safe access to shared session data and to synchronize operations that 
affect the WebSocket or session state. After processing the command, it unlocks the session mutex and signals 
readiness for more data.

Overall, `websocket_cb` acts as the main dispatcher for client interactions, managing session lifecycle, interpreting 
commands, and ensuring robust, concurrent operation for multiple clients in a real-time SDR web application.
*/
onion_connection_status websocket_cb(void *data, onion_websocket * ws,
                                               ssize_t data_ready_len) {
  struct session *sp=find_session_from_websocket(ws);
  if(sp==NULL) {
    ONION_ERROR("Error did not find session for: ws=%p", ws);
    return OCS_NEED_MORE_DATA;
  }

  if ((int) data_ready_len < 0) {
    // The browser is closing the connection
    websocket_closed(sp);
    delete_session(sp);                         // Note that this releases the lock
    return OCS_CLOSE_CONNECTION;
  }

  char tmp[MAX_BINS];
  if (data_ready_len > sizeof(tmp))
    data_ready_len = sizeof(tmp) - 1;

  //fprintf(stderr,"websocket_cb: ws=%p len=%ld\n",ws,data_ready_len);

  int len = onion_websocket_read(ws, tmp, data_ready_len);
  if (len <= 0) {
    // client has gone away - need to cleanup
    ONION_ERROR("Error reading data: %d: %s (%d) ws=%p", errno, strerror(errno),
                data_ready_len,ws);
    websocket_closed(sp);
    delete_session(sp);                         // Note that this releases the lock
    return OCS_CLOSE_CONNECTION;
  }
  tmp[len] = 0;

  //ONION_INFO("Read from websocket: %d: %s", len, tmp);


  char *token=strtok(tmp,":");
  if(strlen(token)==1) {
    switch(*token) {
      case 'S':
      case 's':
        char *temp=malloc(16);
        sprintf(temp,"S:%d",sp->ssrc);
        pthread_mutex_lock(&sp->ws_mutex);
        onion_websocket_set_opcode(sp->ws,OWS_TEXT);
        int r=onion_websocket_write(sp->ws,temp,strlen(temp));
        if(r!=strlen(temp)) {
          fprintf(stderr,"%s: S: response failed: %d\n",__FUNCTION__,r);
        }
        pthread_mutex_unlock(&sp->ws_mutex);
        free(temp);
        // client is ready - start spectrum thread
        if(pthread_create(&sp->spectrum_task,NULL,spectrum_thread,sp) == -1){
          perror("pthread_create: spectrum_thread");
        } else {
          char buff[16];
          snprintf(buff,16,"spec_%u",sp->ssrc+1);
          pthread_setname_np(sp->spectrum_task, buff);
        }
        break;
      case 'A':
      case 'a':
        token=strtok(NULL,":");
        if(strcmp(token,"START")==0) {
          sp->audio_active=true;
        } else if(strcmp(&tmp[2],"STOP")==0) {
          sp->audio_active=false;
        }
        break;
      case 'F':
      case 'f':
  sp->frequency = strtod(&tmp[2],0) * 1000;
    int32_t span = sp->bin_width * sp->bins;
    int32_t min_f = sp->center_frequency - (span / 2);
    int32_t max_f = sp->center_frequency + (span / 2);
    int32_t edge_outside_margin_frequency = 50 * sp->bin_width;
    int32_t edge_bin_margin = 30; // Number of bins to keep tuned frequency away from the edge
    // Shift if frequency is within edge_bin_margin bins of the edge
    if (sp->frequency < min_f + edge_bin_margin * sp->bin_width) {
      if ((min_f + edge_bin_margin * sp->bin_width) - sp->frequency <= edge_outside_margin_frequency) {
        // Shift so that frequency is edge_bin_margin bins above the new min edge
        int32_t shift = ((min_f + edge_bin_margin * sp->bin_width - sp->frequency + sp->bin_width - 1) / sp->bin_width);
        sp->center_frequency -= shift * sp->bin_width;
      } else {
        sp->center_frequency = sp->frequency;
      }
    } else if (sp->frequency > max_f - edge_bin_margin * sp->bin_width) {
      if (sp->frequency - (max_f - edge_bin_margin * sp->bin_width) <= edge_outside_margin_frequency) {
        // Shift so that frequency is edge_bin_margin bins below the new max edge
        int32_t shift = ((sp->frequency - (max_f - edge_bin_margin * sp->bin_width) + sp->bin_width - 1) / sp->bin_width);
        sp->center_frequency += shift * sp->bin_width;
      } else {
        sp->center_frequency = sp->frequency;
      }
    }
        check_frequency(sp);
        control_set_frequency(sp,&tmp[2]);
        break;
      case 'M':
      case 'm':
        control_set_mode(sp,&tmp[2]);
        control_poll(sp);
        break;
      case 'Z':
      case 'z':
        token=strtok(NULL,":");
        if(strcmp(token,"+")==0) {
          pthread_mutex_lock(&sp->spectrum_mutex);
          zoom(sp,1);
          pthread_mutex_unlock(&sp->spectrum_mutex);
          check_frequency(sp);
        } else if(strcmp(token,"-")==0) {
          pthread_mutex_lock(&sp->spectrum_mutex);
          zoom(sp,-1);
          pthread_mutex_unlock(&sp->spectrum_mutex);
          check_frequency(sp);
        } else if(strcmp(token,"c")==0) {
          /* If a center value follows, use it; otherwise do not force the
             center to the tuned frequency. This allows client panning to
             move the visible window past the tuned frequency without the
             server nudging it back into view. */
          token = strtok(NULL,":");
          if (token)
          {
            char *endptr;
            double f = strtod(token,&endptr) * 1000.0;
            if (token != endptr) {
              sp->center_frequency = f;
            }
          }
       /* Ensure center stays within sample-rate bounds. Do NOT call
         check_frequency() here because it will move the center to
         include the tuned frequency; we want client panning to be
         respected. */
       adjust_center_within_bounds(sp);
          /* Immediately request updated spectrum bins for the new center */
          pthread_mutex_lock(&sp->spectrum_mutex);
          control_get_powers(sp,(float)sp->center_frequency,sp->bins,(float)sp->bin_width);
          pthread_mutex_unlock(&sp->spectrum_mutex);
          control_poll(sp);
        } else if (strcmp(token, "SIZE") == 0) { // New command to get zoom table size
            int table_size = sizeof(zoom_table) / sizeof(zoom_table[0]);
            char response[16];
            snprintf(response, sizeof(response), "ZSIZE:%d", table_size);
            pthread_mutex_lock(&sp->ws_mutex);
            onion_websocket_set_opcode(sp->ws, OWS_TEXT);
            onion_websocket_write(sp->ws, response, strlen(response));
            pthread_mutex_unlock(&sp->ws_mutex);
        } else {
          char *end_ptr;
          long int zoom_level = strtol(&tmp[2],&end_ptr,10);
          if (&tmp[2] != end_ptr) {
            pthread_mutex_lock(&sp->spectrum_mutex);
            zoom_to(sp,zoom_level);
            pthread_mutex_unlock(&sp->spectrum_mutex);
            check_frequency(sp);
          }
        }
        break;
    }
  }

  pthread_mutex_unlock(&session_mutex);

  return OCS_NEED_MORE_DATA;
}

/*
The `main` function serves as the entry point for the KA9Q Web SDR server application. Its primary responsibilities 
are to parse command-line arguments, initialize global resources, set up network connections, and launch the 
web server that handles HTTP and WebSocket requests.

At startup, the function parses command-line options to configure parameters such as the web server port, resource 
directory, multicast group address, radio description, bin precision, verbosity, and whether to run with real-time scheduling. 
These options allow the server to be flexibly configured for different environments and use cases.

After parsing options, the function prints the server version and initializes the global session mutex to ensure 
thread-safe access to session data. It then calls `init_connections` to set up multicast sockets and start background 
threads for control and audio processing. If these initializations fail, the program exits with an error.

Next, the function creates and configures the Onion web server object, enabling multi-threaded operation and disabling 
the default signal handler. It sets up the URL routing table, mapping specific paths to handler functions for 
serving static files, status and version information, and the main SDR web interface. The web server is then 
started with `onion_listen`, entering the main event loop to handle incoming HTTP and WebSocket connections.

When the server is stopped, the function cleans up by freeing the Onion server object and returns an exit code. 
Throughout its execution, the `main` function ensures that all necessary resources are initialized and that the 
server is ready to handle multiple clients concurrently, providing a robust foundation for real-time SDR web 
operations.
*/
int main(int argc,char **argv) {
#define xstr(s) str(s)
#define str(s) #s
  char const *port="8081";
  char const *dirname=xstr(RESOURCES_BASE_DIR) "/html";
  char const *mcast="hf.local";
  App_path=argv[0];
  {
    int c;
    while((c = getopt(argc,argv,"d:p:m:hn:vb:r")) != -1){
      switch(c) {
        case 'd':
          dirname=optarg;
          break;
        case 'p':
          port=optarg;
          break;
        case 'm':
          mcast=optarg;
          break;
        case 'n':
          description_override=optarg;
          break;
      case 'b':
        bin_precision_bytes = atoi(optarg);
        if ((bin_precision_bytes != 1) && (bin_precision_bytes != 2) && (bin_precision_bytes != 4)){
          bin_precision_bytes = 4;      //default to float
        }
        break;
        case 'v':
          ++verbose;
          break;
        case 'r':
          run_with_realtime = true;
          break;
        case 'h':
        default:
          fprintf(stderr,"Usage: %s\n",App_path);
          fprintf(stderr,"       %s [-d directory] [-p port] [-m mcast_address] [-n radio description] [-r]\n",App_path);
          exit(EX_USAGE);
          break;
      }
    }
  }

  fprintf(stderr, "ka9q-web version: v%s\n", webserver_version);
  pthread_mutex_init(&session_mutex,NULL);
  init_connections(mcast);
  onion *o = onion_new(O_THREADED | O_NO_SIGTERM);
  onion_url *urls=onion_root_url(o);
  onion_set_port(o, port);
  onion_set_hostname(o, "::");
  onion_handler *pages = onion_handler_export_local_new(dirname);
  onion_handler_add(onion_url_to_handler(urls), pages);
  onion_url_add(urls, "status", status);
  onion_url_add(urls, "version.json", version);
  onion_url_add(urls, "^$", home);

  onion_listen(o);

  onion_free(o);
  return 0;
}

/*
The `status` function is an HTTP handler responsible for generating and returning a real-time status web page 
for the KA9Q Web SDR server. When a client requests the `/status` URL, this function is invoked to produce an 
HTML page summarizing the current state of all active sessions.

The function begins by writing the basic HTML structure and a page header to the response. It then displays the 
total number of active sessions. If there are any sessions, it generates an HTML table listing key details for 
each one, including the client identifier, SSRC, frequency range, tuned frequency, center frequency, number of 
spectrum bins, bin width, and whether audio streaming is enabled for that session.

To populate the table, the function iterates through the linked list of session structures, extracting and formatting 
the relevant information for each session. After listing all sessions, it closes the table and completes the 
HTML document.

This status page provides a convenient, human-readable overview of the server’s current activity, making it useful 
for monitoring, debugging, and administration. The function is designed to be efficient and thread-safe, ensuring 
that the displayed information accurately reflects the server’s real-time state.
*/
onion_connection_status status(void *data, onion_request * req,
                                          onion_response * res) {
    char text[1024];
    onion_response_write0(res,
      "<!DOCTYPE html>"
      "<html>"
        "<head>"
        "  <title>G0ORX Web SDR - Status</title>"
        "  <meta charset=\"UTF-8\" />"
        "  <meta http-equiv=\"refresh\" content=\"30\" />"
        "</head>"
        "<body>"
        "  <h1>G0ORX Web SDR - Status</h1>");
    sprintf(text,"<b>Sessions: %d</b>",nsessions);
    onion_response_write0(res, text);

    if(nsessions!=0) {
      onion_response_write0(res, "<table border=1>"
         "<tr>"
         "<th>client</th>"
         "<th>ssrc</th>"
         "<th>frequency range(Hz)</th>"
         "<th>frequency(Hz)</th>"
         "<th>center frequency(Hz)</th>"
         "<th>bins</th>"
         "<th>bin width(Hz)</th>"
         "<th>Audio</th>"
         "</tr>");

      struct session *sp = sessions;
      while(sp!=NULL) {
        int32_t min_f=sp->center_frequency-((sp->bin_width*sp->bins)/2);
        int32_t max_f=sp->center_frequency+((sp->bin_width*sp->bins)/2);
        sprintf(text,"<tr><td>%s</td><td>%d</td><td>%d to %d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td><td>%s</td></tr>",sp->client,sp->ssrc,min_f,max_f,sp->frequency,sp->center_frequency,sp->bins,sp->bin_width,sp->audio_active?"Enabled":"Disabled");
        onion_response_write0(res, text);
        sp=sp->next;
      }
      onion_response_write0(res, "</table>");
    }

    onion_response_write0(res,
        "</body>"
        "</html>");
    return OCS_PROCESSED;
}

onion_connection_status version(void *data, onion_request * req,
                                          onion_response * res) {
    char text[1024];
    sprintf(text, "{\"Version\":\"%s\"}", webserver_version);
    onion_response_write0(res, text);
    return OCS_PROCESSED;
}

/*
The `home` function is an HTTP handler responsible for serving the main entry point of the KA9Q Web SDR web 
interface. When a client accesses the root URL of the server, this function is invoked to either redirect the 
client to the main radio interface or to establish a new WebSocket session.

If the request is not a WebSocket upgrade, the function responds with a minimal HTML page that immediately 
redirects the client to `radio.html`, ensuring users are directed to the main application interface.

If the request is a WebSocket upgrade, the function creates a new session structure for the client, assigning 
it a unique SSRC (synchronization source identifier) and initializing session parameters such as frequency, 
center frequency, bin width, and zoom level. It also records the client's description and sets up mutexes for 
thread safety. The new session is added to the global session list, and initial control commands are sent to 
configure the radio backend for this session.

Finally, the function registers the `websocket_cb` callback to handle all future WebSocket communication for 
this session and returns a status indicating that the connection has been upgraded to a WebSocket. This design 
ensures that each client receives a dedicated session and that the server is ready to handle real-time interaction 
with the web interface.
*/
onion_connection_status home(void *data, onion_request * req,
                                          onion_response * res) {
  onion_websocket *ws = onion_websocket_new(req, res);
  //fprintf(stderr,"%s: ws=%p\n",__FUNCTION__,ws);
  if(ws==NULL) {
    onion_response_write0(res,
      "<!DOCTYPE html>"
      "<html>"
        "<head>"
        "  <title>G0ORX Web SDR</title>"
        "  <meta charset=\"UTF-8\" />"
        "  <meta http-equiv=\"refresh\" content=\"0; URL=radio.html\" />"
        "</head>"
        "<body>"
        "</body>"
        "</html>");
    return OCS_PROCESSED;
  }

  // create session
  int i;
  struct session *sp=calloc(1,sizeof(*sp));
  if(nsessions==0) {
    sp->ssrc=START_SESSION_ID;
  } else {
    for(i=0;i<nsessions;i++) {
      struct session *s=find_session_from_ssrc(START_SESSION_ID+(i*2));
      if(s==NULL) {
        break;
      }
      pthread_mutex_unlock(&session_mutex);
    }
    sp->ssrc=START_SESSION_ID+(i*2);
  }
  sp->ws=ws;
  sp->spectrum_active=true;
  sp->audio_active=false;
  sp->frequency=10000000;
  sp->center_frequency = 16200000;
  sp->bins=MAX_BINS;
  sp->bin_width=20000; // width of a pixel in hz
  sp->next=NULL;
  sp->previous=NULL;
  sp->zoom_index = 1;
  sp->bins_min_db = -120;
  sp->bins_max_db = 0;
  sp->bins_autorange_offset = -130;
  sp->bins_autorange_gain = 0.1;
  strlcpy(sp->requested_preset,"am",sizeof(sp->requested_preset));
  strlcpy(sp->client,onion_request_get_client_description(req),sizeof(sp->client));
  pthread_mutex_init(&sp->ws_mutex,NULL);
  pthread_mutex_init(&sp->spectrum_mutex,NULL);
  add_session(sp);
  init_control(sp);
  //fprintf(stderr,"%s: onion_websocket_set_callback: websocket_cb\n",__FUNCTION__);
  onion_websocket_set_callback(ws, websocket_cb);

  return OCS_WEBSOCKET;
}

/* 
The `audio_thread` function is a POSIX thread entry point designed to handle audio packet reception 
and forwarding in a networked application. It begins by allocating memory for a `packet` structure, 
which will be used to store incoming audio data. The function then waits for the `Channel.output.dest_socket` 
to be initialized (its `sa_family` field set), using a mutex and condition variable to synchronize with other
 threads. Once the destination socket is ready, it calls `listen_mcast` to join a multicast group and obtain a
 socket file descriptor for receiving audio data.

If the socket setup fails (`Input_fd == -1`), the thread exits cleanly. Otherwise, the thread enters an infinite 
loop where it waits for incoming packets using `recvfrom`. If an error occurs (other than an interrupt), it logs
the error and briefly sleeps before retrying. It also skips packets that are too small to be valid RTP packets.

For each valid packet, the function parses the RTP header and adjusts the data pointer and length accordingly, 
handling RTP padding if present. It then attempts to find an active session matching the packet's SSRC (synchronization source identifier).
If a session is found and is marked as audio-active, the function locks the session's websocket mutex, sets the 
websocket opcode to binary, and writes the packet data to the websocket. If the write fails, it logs an error. 
After handling the packet, it unlocks the session mutex.

Throughout, the function uses careful synchronization to avoid race conditions, and it is robust against
malformed or unexpected network data. The design allows for real-time forwarding of audio streams from 
multicast to websocket clients, making it suitable for applications like networked audio streaming or 
conferencing.
*/
static void *audio_thread(void *arg) {
  struct session *sp;
  struct packet *pkt = malloc(sizeof(*pkt));

  //fprintf(stderr,"%s\n",__FUNCTION__);

  {
    pthread_mutex_lock(&output_dest_socket_mutex);
    while(Channel.output.dest_socket.sa_family == 0)
        pthread_cond_wait(&output_dest_socket_cond, &output_dest_socket_mutex);
    Input_fd = listen_mcast(NULL,&Channel.output.dest_socket,NULL);
    pthread_mutex_unlock(&output_dest_socket_mutex);
  }

  if(Input_fd==-1) {
    pthread_exit(NULL);
  }

  while(1) {
    struct sockaddr_storage sender;
    socklen_t socksize = sizeof(sender);
    int size = recvfrom(Input_fd,&pkt->content,sizeof(pkt->content),0,(struct sockaddr *)&sender,&socksize);

    if(size == -1){
      if(errno != EINTR){ // Happens routinely, e.g., when window resized
        perror("recvfrom");
        fprintf(stderr,"address=%s\n",formatsock(&Channel.output.dest_socket,false));
        usleep(1000);
      }
      continue;  // Reuse current buffer
    }
    if(size <= RTP_MIN_SIZE)
      continue; // Must be big enough for RTP header and at least some data

    // Convert RTP header to host format
    uint8_t const *dp = ntoh_rtp(&pkt->rtp,pkt->content);
    pkt->data = dp;
    pkt->len = size - (dp - pkt->content);
    if(pkt->rtp.pad){
      pkt->len -= dp[pkt->len-1];
      pkt->rtp.pad = 0;
    }
    if(pkt->len <= 0)
      continue; // Used to be an assert, but would be triggered by bogus packets


    sp=find_session_from_ssrc(pkt->rtp.ssrc);
//fprintf(stderr,"%s: sp=%p ssrc=%d\n",__FUNCTION__,sp,pkt->rtp.ssrc);
    if(sp!=NULL) {
      if(sp->audio_active) {
        //fprintf(stderr,"forward RTP: ws=%p ssrc=%d\n",sp->ws,pkt->rtp.ssrc);
        pthread_mutex_lock(&sp->ws_mutex);
        onion_websocket_set_opcode(sp->ws,OWS_BINARY);
        int r=onion_websocket_write(sp->ws,(const char *)(pkt->content),size);
        pthread_mutex_unlock(&sp->ws_mutex);
        if(r<=0) {
          fprintf(stderr,"%s: write failed: %d\n",__FUNCTION__,r);
        }
      }
      pthread_mutex_unlock(&session_mutex);
    }  // not found
  }

  //fprintf(stderr,"EXIT %s\n",__FUNCTION__);
  return NULL;
}

/*
The `init_connections` function is responsible for initializing network connections and starting background threads
for a networked application that uses multicast communication and threading. It takes a multicast group address as
input and performs several key steps to set up the environment.

First, it prepares a buffer (`iface`) to store the name of the network interface used for multicast. It then 
initializes a mutex (`ctl_mutex`) to ensure thread-safe access to shared resources. The function calls `resolve_mcast`
to resolve the multicast group address and populate the `Metadata_dest_socket` structure, also determining the appropriate
network interface. Next, it attempts to listen for multicast status messages by calling `listen_mcast`. If this fails 
(indicated by `Status_fd == -1`), it logs an error and returns an error code.

If the status socket is set up successfully, the function tries to connect to the multicast control channel using `connect_mcast`. 
If this connection fails, it logs an error and returns an error code as well. Assuming both sockets are ready, 
the function creates two threads: one for control operations (`ctrl_thread`) and one for audio processing (`audio_thread`). 
For each thread, it checks if thread creation was successful; if not, it logs an error. If successful, it assigns 
a human-readable name to each thread using `pthread_setname_np` for easier debugging and monitoring.

Finally, if all steps succeed, the function returns a success code (`EX_OK`). This setup ensures that the application 
can communicate over multicast, handle control messages, and process audio data concurrently in separate threads, 
providing a robust foundation for real-time networked operations.
*/
int init_connections(const char *multicast_group) {
  char iface[1024]; // Multicast interface

  pthread_mutex_init(&ctl_mutex,NULL);

  resolve_mcast(multicast_group,&Metadata_dest_socket,DEFAULT_STAT_PORT,iface,sizeof(iface),0);
  Status_fd = listen_mcast(NULL,&Metadata_dest_socket,iface);
  if(Status_fd == -1){
    fprintf(stderr,"Can't listen to mcast status %s\n",multicast_group);
    return(EX_IOERR);
  }

  Ctl_fd = connect_mcast(&Metadata_dest_socket,iface,Mcast_ttl,IP_tos);
  if(Ctl_fd < 0){
    fprintf(stderr,"connect to mcast control failed: RX\n");
    return(EX_IOERR);
  }

  if(pthread_create(&ctrl_task,NULL,ctrl_thread,NULL) == -1){
    perror("pthread_create: ctrl_thread");
    //free(sp);
  } else {
    char buff[16];
    snprintf(buff,16,"ctrl");
    pthread_setname_np(ctrl_task,buff);
  }

  if(pthread_create(&audio_task,NULL,audio_thread,NULL) == -1){
    perror("pthread_create");
  } else {
    char buff[16];
    snprintf(buff,16,"audio");
    pthread_setname_np(audio_task,buff);
  }
  return(EX_OK);
}

/*
The `init_control` function is responsible for initializing control communication for a session in a networked 
application, likely related to radio or audio streaming. It takes a pointer to a `session` structure as its 
argument. The function prepares and sends two command packets over a control socket, each packet configuring a 
specific SSRC (Synchronization Source identifier) for the session.

First, the function creates a command buffer and a pointer (`bp`) to build the command message. It writes a 
command identifier, encodes a frequency value, the session's SSRC, a randomly generated command tag, and a 
preset string ("am") into the buffer. It then finalizes the command with an end-of-line marker and calculates 
the total length of the command. The function locks a mutex (`ctl_mutex`) to ensure thread-safe access to the 
control socket (`Ctl_fd`) and sends the command. If the send operation fails, it logs an error message. The 
mutex is then unlocked.

The process is repeated for a second command, this time incrementing the SSRC by one and omitting the preset string. 
Again, the command is sent over the control socket with proper mutex protection.

After sending both commands, the function initializes the demodulator for the channel by calling `init_demod(&Channel)`. 
It also resets the frontend frequency and intermediate frequency (IF) values to "not a number" (`NAN`), indicating 
that these values are not currently set. Finally, the function returns a success code (`EX_OK`). This setup ensures 
that the session is properly configured and ready for further control operations.
*/
int init_control(struct session *sp) {
  uint32_t sent_tag = 0;

//fprintf(stderr,"%s: Ssrc=%d\n",__FUNCTION__,sp->ssrc);
  // send a frequency to start with
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  *bp++ = CMD; // Command

  encode_double(&bp,RADIO_FREQUENCY,10000000);
  encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // Specific SSRC
  sent_tag = arc4random();
  encode_int(&bp,COMMAND_TAG,sent_tag); // Append a command tag
  encode_string(&bp,PRESET,"am",strlen("am"));
  encode_eol(&bp);
  int command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
    fprintf(stderr,"command send error: %s\n",strerror(errno));
  }
  pthread_mutex_unlock(&ctl_mutex);

  bp = cmdbuffer;
  *bp++ = CMD; // Command

  encode_double(&bp,RADIO_FREQUENCY,10000000);
  encode_int(&bp,OUTPUT_SSRC,sp->ssrc+1); // Specific SSRC
  sent_tag = arc4random();
  encode_int(&bp,COMMAND_TAG,sent_tag); // Append a command tag
  encode_eol(&bp);
  command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
    fprintf(stderr,"command send error: %s\n",strerror(errno));
  }
  pthread_mutex_unlock(&ctl_mutex);

  init_demod(&Channel);

  Frontend.frequency = Frontend.min_IF = Frontend.max_IF = NAN;

  return(EX_OK);
}

/*
The `control_set_frequency` function is designed to send a command to set the frequency for a given 
session in a networked application, likely related to radio or audio streaming. It takes two parameters: 
a pointer to a `session` structure (`sp`) and a string (`str`) representing the desired frequency in 
kilohertz (kHz).

The function first checks if the input string is non-empty. If so, it begins constructing a command packet 
in the `cmdbuffer` array. The first byte of the buffer is set to a constant `CMD`, indicating the type of 
command. The function then converts the frequency string from kHz to hertz (Hz) by parsing it as a double 
and multiplying by 1000, ensuring the value is positive with `fabs`. This frequency value is stored in the 
session's `frequency` field and encoded into the command buffer using `encode_double`.

Next, the function encodes the session's SSRC (Synchronization Source identifier) and a randomly generated 
command tag into the buffer using `encode_int`. It finalizes the command with an end-of-line marker via 
`encode_eol`. The total length of the command is calculated as the difference between the current buffer 
pointer and the start of the buffer.

To ensure thread safety, the function locks the `ctl_mutex` mutex before sending the command over the control 
socket (`Ctl_fd`). If the `send` operation fails to transmit the entire command, an error message is printed. 
Finally, the mutex is unlocked, allowing other threads to access the control socket.

Overall, this function safely constructs and sends a frequency-setting command for a session, handling 
string parsing, buffer management, and thread synchronization.
*/
void control_set_frequency(struct session *sp,char *str) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  double f;

  if(strlen(str) > 0){
    *bp++ = CMD; // Command
    f = fabs(strtod(str,0) * 1000.0);    // convert from kHz to Hz
  sp->frequency = f;
    encode_double(&bp,RADIO_FREQUENCY,f);
    encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // Specific SSRC
    encode_int(&bp,COMMAND_TAG,arc4random()); // Append a command tag
    encode_eol(&bp);
    int const command_len = bp - cmdbuffer;
    pthread_mutex_lock(&ctl_mutex);
    if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
      fprintf(stderr,"command send error: %s\n",strerror(errno));
    }
    pthread_mutex_unlock(&ctl_mutex);
  }
}

/*
The `control_set_mode` function is responsible for sending a command to change the mode (or preset) of a 
session in a networked application, likely related to radio or audio streaming. It takes two parameters: 
a pointer to a `session` structure (`sp`) and a string (`str`) that specifies the desired mode or preset.

The function first checks if the provided string is non-empty. If so, it begins constructing a command packet 
in the `cmdbuffer` array. The first byte of the buffer is set to a constant `CMD`, which likely indicates the 
type of command being sent. The function then encodes the mode string into the buffer using `encode_string`, 
associating it with the `PRESET` field. It also encodes the session's SSRC (Synchronization Source identifier) 
and a randomly generated command tag into the buffer using `encode_int`. The command is finalized with an 
end-of-line marker via `encode_eol`, and the total length of the command is calculated.

To ensure thread safety, the function locks the `ctl_mutex` mutex before sending the command over the control socket 
(`Ctl_fd`). It also copies the requested preset string into the session's `requested_preset` field for tracking 
purposes. If the `send` operation fails to transmit the entire command, an error message is printed. 
Finally, the mutex is unlocked, allowing other threads to access the control socket. 
This approach ensures that mode changes are communicated reliably and safely in a concurrent environment.
*/
void control_set_mode(struct session *sp,char *str) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;

  if(strlen(str) > 0) {
    *bp++ = CMD; // Command
    encode_string(&bp,PRESET,str,strlen(str));
    encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // Specific SSRC
    encode_int(&bp,COMMAND_TAG,arc4random()); // Append a command tag
    encode_eol(&bp);
    int const command_len = bp - cmdbuffer;
    pthread_mutex_lock(&ctl_mutex);
    strlcpy(sp->requested_preset,str,sizeof(sp->requested_preset));
    if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
      fprintf(stderr,"command send error: %s\n",strerror(errno));
    }
    pthread_mutex_unlock(&ctl_mutex);
  }
}


/*
The `stop_spectrum_stream` function is designed to send a command to stop a spectrum demodulator stream for a 
given session in a networked application, likely related to radio or signal processing. The function takes a 
pointer to a `session` structure as its argument. It begins by preparing a command buffer (`cmdbuffer`) and a 
pointer (`bp`) to build the command message. The first byte of the buffer is set to a constant `CMD`, indicating 
the type of command.

Next, the function encodes several pieces of information into the buffer: the SSRC (Synchronization Source identifier) 
for the spectrum stream (using `sp->ssrc + 1`), a randomly generated command tag, the demodulator type (set to `SPECT_DEMOD` 
to specify a spectrum demodulator), and a frequency value of 0 Hz (which is used as a signal to stop the stream). 
The command is finalized with an end-of-line marker, and the total length of the command is calculated.

To ensure the command is reliably received, the function sends the command three times in a loop, with a 
short delay (`usleep(100000)`, or 100 milliseconds) between each attempt. Before each send, it locks a 
mutex (`ctl_mutex`) to ensure thread-safe access to the control socket (`Ctl_fd`). If the send operation fails, 
it prints an error message. If the `verbose` flag is set, the function also logs a message to standard error each 
time it sends the command, including the tag and SSRC used. After sending, it unlocks the mutex.

This approach ensures that the command to stop the spectrum stream is sent reliably, even in the presence of 
potential packet loss or network issues. The use of mutex locking ensures that multiple threads do not interfere 
with each other when accessing the control socket. The function is robust and suitable for use in a concurrent, 
networked environment.
*/
void stop_spectrum_stream(struct session *sp) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  *bp++ = CMD; // Command
  encode_int(&bp,OUTPUT_SSRC,sp->ssrc+1);
  uint32_t tag = random();
  encode_int(&bp,COMMAND_TAG,tag);
  encode_int(&bp,DEMOD_TYPE,SPECT_DEMOD);
  encode_double(&bp,RADIO_FREQUENCY,0);
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  for(int i = 0; i < 3; ++i) {
    if (verbose)
      fprintf(stderr,"%s(): Tune 0 Hz with tag 0x%08x to close spec demod thread on SSRC %u\n",__FUNCTION__,tag,sp->ssrc+1);
    pthread_mutex_lock(&ctl_mutex);
    if(send(Ctl_fd,cmdbuffer,command_len,0) != command_len) {
      perror("command send: Spectrum");
    }
    pthread_mutex_unlock(&ctl_mutex);
    usleep(100000);
  }
}

/*
The `control_get_powers` function is responsible for sending a command to request spectral power data from a 
remote system, likely in the context of a radio or signal processing application. It takes as arguments a pointer 
to a `session` structure (`sp`), a frequency value (`frequency`), the number of bins (`bins`), and the bandwidth 
per bin (`bin_bw`). These parameters define the spectral region and resolution for which power data is being requested.

Inside the function, a command buffer (`cmdbuffer`) is prepared to hold the serialized command. The buffer pointer (`bp`) 
is used to sequentially encode each part of the command. The command starts with a command identifier (`CMD`), followed 
by the output SSRC (Synchronization Source identifier) for the session, which is incremented by one to target the correct 
stream. A random tag is generated to uniquely identify this command transaction, aiding in matching responses to requests.

The function then encodes several parameters into the buffer: the demodulator type (set to `SPECT_DEMOD` to indicate a 
spectrum analysis request), the center frequency, the number of bins, and the bandwidth per bin. Each of these values is 
encoded using helper functions like `encode_int`, `encode_double`, and `encode_float`, which serialize the data into the 
buffer in the required format. The command is finalized with an end-of-line marker using `encode_eol`.

Once the command is fully constructed, its length is calculated, and the function locks a mutex (`ctl_mutex`) to ensure 
thread-safe access to the control socket (`Ctl_fd`). The command is then sent over the socket using the `send` function. 
If the send operation does not transmit the expected number of bytes, an error message is printed. Finally, the mutex is 
unlocked, allowing other threads to use the control socket. This approach ensures that spectral power requests are sent 
safely and reliably in a concurrent, networked environment.
*/
void control_get_powers(struct session *sp,float frequency,int bins,float bin_bw) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  *bp++ = CMD; // Command
  encode_int(&bp,OUTPUT_SSRC,sp->ssrc+1);
  uint32_t tag = random();
  encode_int(&bp,COMMAND_TAG,tag);
  encode_int(&bp,DEMOD_TYPE,SPECT_DEMOD);
  encode_double(&bp,RADIO_FREQUENCY,frequency);
  encode_int(&bp,BIN_COUNT,bins);
  encode_float(&bp,NONCOHERENT_BIN_BW,bin_bw);
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    perror("command send: Spectrum");
  }
  pthread_mutex_unlock(&ctl_mutex);
}

/*
The `control_poll` function is designed to send a polling command to a remote system, typically as part of a 
networked application that manages sessions (such as a radio or streaming server). The function takes a pointer 
to a `session` structure as its argument, which contains information about the current session, including its 
SSRC (Synchronization Source identifier).

Inside the function, a buffer (`cmdbuffer`) is allocated to hold the command data. A pointer (`bp`) is used to 
build the command sequentially. The first byte of the buffer is set to `1`, which likely represents the command 
type for polling. The function then encodes a random command tag using `encode_int`, which helps uniquely identify 
this poll request and match it with any response. The session's SSRC is also encoded, allowing the poll to target 
a specific session or, if set to zero, to request a list of available SSRCs. The command is finalized with an 
end-of-line marker using `encode_eol`.

After constructing the command, the function calculates its length and locks a mutex (`ctl_mutex`) to ensure 
thread-safe access to the control socket (`Ctl_fd`). It then sends the command using the `send` function. 
If the number of bytes sent does not match the expected command length, an error message is printed using `perror`. 
Finally, the mutex is unlocked, allowing other threads to use the control socket. This approach ensures that polling 
commands are sent safely and reliably in a concurrent, networked environment.
*/
void control_poll(struct session *sp) {
  uint8_t cmdbuffer[128];
  uint8_t *bp = cmdbuffer;
  *bp++ = 1; // Command

  /* sp->last_poll_tag = random(); */
  /* encode_int(&bp,COMMAND_TAG,sp->last_poll_tag); */
  encode_int(&bp,COMMAND_TAG,random());
  encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // poll specific SSRC, or request ssrc list with ssrc = 0
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    perror("command send: Poll");
  }
  pthread_mutex_unlock(&ctl_mutex);
}

/*
The `extract_powers` function is designed to parse a binary buffer containing a sequence of tagged data fields 
(often called TLVs: Type-Length-Value) and extract spectral power information for a given session. This function 
is typically used in applications that process spectrum or signal analysis data, such as radio receivers or spectrum 
analyzers.

The function takes several parameters: pointers to arrays and variables where it will store the extracted power 
values, time, frequency, and bin bandwidth; the expected SSRC (stream/source identifier); the input buffer and 
its length; and a pointer to the session structure for storing additional results.

The function iterates through the buffer, reading one TLV field at a time. For each field, it reads the type 
(an enum value), then the length. If the length byte indicates a value of 128 or more, it uses additional bytes 
to determine the actual length, supporting variable-length fields. It then checks that the field does not extend 
beyond the buffer’s end to avoid buffer overflows.

Depending on the type, the function decodes the value using helper functions (like `decode_int64`, `decode_double`, 
or `decode_float`) and stores the result in the appropriate output variable or session field. For example, if the 
type is `BIN_DATA`, it decodes an array of floating-point power values, updates the session’s min/max dB values, 
and checks that the number of bins does not exceed the provided array size. It also handles other types such as 
GPS time, frequency, demodulator type, and IF power.

After parsing, the function checks for consistency between the number of bins reported and the number of bins actually 
decoded, and ensures the count does not exceed a maximum allowed value. If any check fails, it returns an error 
code; otherwise, it returns the number of bins extracted.

Overall, this function is robust against malformed or unexpected data, and is careful to avoid buffer overruns 
and to validate all extracted information. It is a good example of defensive programming in a low-level data parsing 
context.
*/
int extract_powers(float *power,int npower,uint64_t *time,double *freq,double *bin_bw,int32_t const ssrc,uint8_t const * const buffer,int length,struct session *sp){
#if 0  // use later
  double l_lo1 = 0,l_lo2 = 0;
#endif
  int l_ccount = 0;
  uint8_t const *cp = buffer;
  int l_count=1234567;

//fprintf(stderr,"%s: length=%d\n",__FUNCTION__,length);
  while(cp - buffer < length){
    enum status_type const type = *cp++; // increment cp to length field

    if(type == EOL)
      break; // End of list

    unsigned int optlen = *cp++;
    if(optlen & 0x80){
      // length is >= 128 bytes; fetch actual length from next N bytes, where N is low 7 bits of optlen
      int length_of_length = optlen & 0x7f;
      optlen = 0;
      while(length_of_length > 0){
        optlen <<= 8;
        optlen |= *cp++;
        length_of_length--;
      }
    }
    if(cp - buffer + optlen >= length)
      break; // Invalid length
    switch(type){
    case EOL: // Shouldn't get here
      goto done;
    case GPS_TIME:
      *time = decode_int64(cp,optlen);
      break;
    case OUTPUT_SSRC: // Don't really need this, it's already been checked
      if(decode_int32(cp,optlen) != ssrc)
        return -1; // Not what we want
      break;
    case DEMOD_TYPE:
     {
        const int i = decode_int(cp,optlen);
        if(i != SPECT_DEMOD)
          return -3; // Not what we want
      }
      break;
    case RADIO_FREQUENCY:
      *freq = decode_double(cp,optlen);
      break;
#if 0  // Use this to fine-tweak freq later
    case FIRST_LO_FREQUENCY:
      l_lo1 = decode_double(cp,optlen);
      break;
    case SECOND_LO_FREQUENCY: // ditto
      l_lo2 = decode_double(cp,optlen);
      break;
#endif
    case BIN_DATA:
      l_count = optlen/sizeof(float);
      if(l_count > npower)
        return -2; // Not enough room in caller's array
      // Note these are still in FFT order
      int64_t N = (Frontend.L + Frontend.M - 1);
      if (0 == N)
         break;
      sp->bins_max_db = -9e99;
      sp->bins_min_db = 9e99;
      for(int i=0; i < l_count; i++){
        power[i] = decode_float(cp,sizeof(float));
        if (power[i] > sp->bins_max_db)
          sp->bins_max_db = power[i];
        if (power[i] < sp->bins_min_db)
          sp->bins_min_db = power[i];
        cp += sizeof(float);
      }
      sp->bins_min_db = (sp->bins_min_db == 0) ? -120 : 10.0 * log10(sp->bins_min_db);
      sp->bins_max_db = (sp->bins_max_db == 0) ? -120 : 10.0 * log10(sp->bins_max_db);
      break;
    case NONCOHERENT_BIN_BW:
      *bin_bw = decode_float(cp,optlen);
      break;
    case IF_POWER:
      // newell 12/1/2024, 19:09:01
      // I expected decode_radio_status() to handle this and NOISE_DENSITY, but
      // the values never seemed to be live. Maybe they're part of the channel
      // instead? This seems to work for now at least.
      sp->if_power = decode_float(cp,optlen);
      break;
    case BIN_COUNT: // Do we check that this equals the length of the BIN_DATA tlv?
      l_ccount = decode_int(cp,optlen);
      break;
    default:
      break;
    }
    cp += optlen;
  }
 done:

  if (l_count != l_ccount) {
    // not the expected number of bins...not sure why, but avoid crashing for now
    /* if (verbose) { */
    /*   ++error_count; */
    /*   fprintf(stderr,"BIN_COUNT error %d on ssrc %d BIN_DATA had %d bins, but BIN_COUNT was %d, packet length %d bytes tag %08X\n",error_count,ssrc,l_count,l_ccount,length, sp->last_poll_tag); */
    /*   fflush(stderr); */
    /* } */
    return -1;
  }

  if (l_count > MAX_BINS) {
    /* if (verbose) { */
    /*   ++error_count; */
    /*   fprintf(stderr,"BIN_DATA error %d on ssrc %d shows %d bins, BIN_COUNT was %d, but MAX_BINS is %d\n",error_count,ssrc,l_count,l_ccount,MAX_BINS); */
    /*   fflush(stderr); */
    /* } */
    return -1;
  }
  return l_ccount;
}

/*
The `extract_noise` function is designed to parse a binary buffer containing tagged data fields and extract the 
noise density value for a given session. The function takes four parameters: a pointer to a float (`n0`) where 
the extracted noise value will be stored, a pointer to the start of the buffer (`buffer`), the length of the buffer 
(`length`), and a pointer to a session structure (`sp`). The function iterates through the buffer, reading one 
field at a time in a loop.

Each field in the buffer is expected to follow a Type-Length-Value (TLV) format. The function first reads the type 
(an enum value) and then the length of the field. If the length byte indicates a value of 128 or more (the high bit is set), 
the actual length is encoded in the following bytes, allowing for fields longer than 127 bytes. The function decodes this extended length as needed.

For each field, the function checks that the field does not extend beyond the end of the buffer to prevent buffer overruns. 
It then uses a switch statement to handle different field types. If the field type is `NOISE_DENSITY`, it decodes the value 
as a float and stores it in the location pointed to by `n0`. If the type is `EOL` (end of list), the function breaks 
out of the loop. For any other type, it simply skips over the field.

After processing all fields or encountering an end-of-list marker, the function returns 0. This function is robust 
against malformed or unexpected data, as it checks buffer boundaries and handles variable-length fields. It is 
a typical example of defensive programming for parsing binary protocols in C or C++.
*/
int extract_noise(float *n0,uint8_t const * const buffer,int length,struct session *sp){
  uint8_t const *cp = buffer;

  while(cp - buffer < length){
    enum status_type const type = *cp++; // increment cp to length field

    if(type == EOL)
      break; // End of list

    unsigned int optlen = *cp++;
    if(optlen & 0x80){
      // length is >= 128 bytes; fetch actual length from next N bytes, where N is low 7 bits of optlen
      int length_of_length = optlen & 0x7f;
      optlen = 0;
      while(length_of_length > 0){
        optlen <<= 8;
        optlen |= *cp++;
        length_of_length--;
      }
    }
    if(cp - buffer + optlen >= length)
      break; // Invalid length
    switch(type){
    case EOL: // Shouldn't get here
      goto done;
    case NOISE_DENSITY:
      *n0 = decode_float(cp,optlen);
      break;
    default:
      break;
    }
    cp += optlen;
  }
  done:

  return 0;
}

/*
The `init_demod` function is a C/C++ function designed to initialize (or reset) all fields of a `channel` structure 
to a known state, typically before use or reuse. The function takes a pointer to a `channel` structure as its argument. 
The first operation it performs is a call to `memset`, which sets all bytes in the structure to zero. This ensures that 
all fields, including any padding or uninitialized memory, are cleared.

After zeroing the structure, the function explicitly sets many floating-point fields within nested structures of `channel` 
to `NAN` (Not-a-Number). This is a common technique in signal processing and scientific computing to indicate that a 
value is undefined or uninitialized, as opposed to being zero, which might be a valid value in some contexts. The fields 
set to `NAN` include various tuning parameters (such as `second_LO`, `freq`, and `shift`), filter parameters 
(`min_IF`, `max_IF`, `kaiser_beta`), output and linear processing parameters (`headroom`, `hangtime`, `recovery_rate`), 
signal statistics (`bb_power`, `snr`, `foffset`), FM and PLL parameters (`pdeviation`, `cphase`), output gain, and two 
test points (`tp1`, `tp2`). 

By explicitly setting these fields to `NAN` after the `memset`, the function ensures that any code using this structure 
can reliably detect uninitialized or invalid values, which can help with debugging and error handling. The function 
returns `0` to indicate successful initialization. This pattern of zeroing a structure and then setting specific fields 
to sentinel values is a robust way to prepare complex data structures for use in C and C++ programs, especially 
in applications like DSP (digital signal processing) or communications where distinguishing between "zero" and "invalid" 
is important.
*/
int init_demod(struct channel *channel){
  memset(channel,0,sizeof(*channel));
  channel->tune.second_LO = NAN;
  channel->tune.freq = channel->tune.shift = NAN;
  channel->filter.min_IF = channel->filter.max_IF = channel->filter.kaiser_beta = NAN;
  channel->output.headroom = channel->linear.hangtime = channel->linear.recovery_rate = NAN;
  channel->sig.bb_power = channel->sig.foffset = NAN;
  channel->fm.pdeviation = channel->pll.cphase = NAN;
  channel->output.gain = NAN;
  channel->tp1 = channel->tp2 = NAN;
  return 0;
}

/*
The `spectrum_thread` function is a POSIX thread routine designed to periodically request and poll spectrum data 
for a given session in a concurrent C or C++ application. It takes a pointer to a `session` structure as its argument, 
which it casts from a generic `void*` pointer. The function runs in a loop as long as the `spectrum_active` flag in 
the session remains true, allowing the thread to be cleanly stopped from elsewhere in the program.

Within each iteration of the loop, the thread first locks the `spectrum_mutex` associated with the session to ensure 
thread-safe access to shared spectrum-related data. It then calls `control_get_powers`, passing the session pointer and 
relevant parameters such as the center frequency, number of bins, and bin width. This function likely sends a 
command to a remote server or device to request a new set of spectrum power measurements. After the request is sent, 
the mutex is unlocked, allowing other threads to access or modify the session's spectrum data.

Next, the thread calls `control_poll`, which probably sends a poll command to check the status or retrieve results 
from the remote system. To avoid overwhelming the system and to pace the requests, the thread sleeps for 100 milliseconds 
using `usleep(100000)`. If the sleep call fails, an error message is printed. The loop then repeats, continuing to request 
and poll spectrum data as long as the session remains active.

This design allows spectrum data to be requested and processed in the background, independently of the main 
application flow. The use of mutexes ensures that shared data is accessed safely in a multithreaded environment, 
and the periodic polling mechanism provides a balance between responsiveness and resource usage. The function 
returns `NULL` when the thread exits, as required by the POSIX thread API.
*/
void *spectrum_thread(void *arg) {
  struct session *sp = (struct session *)arg;
  //fprintf(stderr,"%s: %d\n",__FUNCTION__,sp->ssrc);
  while(sp->spectrum_active) {
    pthread_mutex_lock(&sp->spectrum_mutex);
    control_get_powers(sp,(float)sp->center_frequency,sp->bins,(float)sp->bin_width);
    pthread_mutex_unlock(&sp->spectrum_mutex);
    control_poll(sp);
    if(usleep(100000) !=0) {
      perror("spectrum_thread: usleep(100000)");
    }
  }
  //fprintf(stderr,"%s: %d EXIT\n",__FUNCTION__,sp->ssrc);
  return NULL;
}

/* Borrowed from ka9q-radio misc.c, commit
   920b0921e0db3a2ca0cbb4a38707fb62ae02cd63

   Change warning message to clarify ka9q-web needs to be run as root (!) or
   maybe with CAP_SYS_NICE capability? to switch to a realtime priority. Whether
   you want to do that is another question. WD doesn't appear to run it as root
   or with CAP_SYS_NICE, and the warnings weren't emitted before, so now the
   call to realtim() is gated behind a CLI flag.
 */

// Set realtime priority (if possible)

/*
The `set_realtime` function is designed to elevate the scheduling priority of the calling thread or process, 
aiming to achieve real-time or near real-time execution on Linux systems. This is particularly useful for 
applications that require low-latency or time-critical processing, such as audio streaming, signal processing, 
or other performance-sensitive tasks.

The function first checks if it is running on a Linux system using the `__linux__` preprocessor macro. If so, 
it attempts to set the thread's scheduling policy to `SCHED_FIFO` (First-In, First-Out), which is a real-time 
scheduling class in Linux. It does this by determining the minimum and maximum priorities available for `SCHED_FIFO` 
and then selecting a priority value midway between them. The `sched_setscheduler` system call is used to apply this 
policy and priority to the current thread or process. If this call succeeds, the function returns immediately, 
indicating that real-time scheduling has been successfully set.

If the attempt to set real-time scheduling fails (which can happen if the process lacks the necessary privileges, 
such as root access or the `CAP_SYS_NICE` capability), the function retrieves the thread's name and prints a warning 
message to standard output, explaining the failure and the likely cause.

As a fallback, the function tries to improve the process's priority by decreasing its "niceness" value by 10 
using the `setpriority` system call. Lower niceness values correspond to higher scheduling priority in the 
standard Linux scheduler. If this call also fails, another warning message is printed, again indicating that 
elevated privileges are required to change process priority.

Overall, the function is robust: it first tries to achieve the best possible scheduling policy for 
real-time performance, and if that fails, it attempts a less powerful but still helpful adjustment. 
It also provides clear feedback to the user if neither approach succeeds, helping with troubleshooting and 
system configuration.
*/
void set_realtime(void){
#ifdef __linux__
  static int minprio = -1; // Save the extra system calls
  static int maxprio = -1;
  if(minprio == -1 || maxprio == -1){
    minprio = sched_get_priority_min(SCHED_FIFO);
    maxprio = sched_get_priority_max(SCHED_FIFO);
  }
  struct sched_param param = {0};
  param.sched_priority = (minprio + maxprio) / 2; // midway?
  if(sched_setscheduler(0,SCHED_FIFO|SCHED_RESET_ON_FORK,&param) == 0)
    return; // Successfully set realtime
  {
    char name[25];
    int err = errno;
    if(pthread_getname_np(pthread_self(),name,sizeof(name)) == 0){
      fprintf(stdout,"%s: sched_setscheduler failed, %s (%d) -- you need to be root or have CAP_SYS_NICE to set realtime priority!\n",name,strerror(err),err);
    }
  }
#endif
  // As backup, decrease our niceness by 10
  int Base_prio = getpriority(PRIO_PROCESS,0);
  errno = 0; // setpriority can return -1
  int prio = setpriority(PRIO_PROCESS,0,Base_prio - 10);
  if(prio != 0){
    int err = errno;
    char name[25];
    memset(name,0,sizeof(name));
    if(pthread_getname_np(pthread_self(),name,sizeof(name)-1) == 0){
      fprintf(stdout,"%s: setpriority failed, %s (%d) -- you need to be root or have CAP_SYS_NICE to set realtime priority!\n",name,strerror(err),err);
    }
  }
}

/*
The `ctrl_thread` function is a POSIX thread routine responsible for handling incoming status and spectrum data packets, 
processing them, and forwarding relevant information to connected clients via WebSockets. This function is part 
of a larger C++ project that deals with real-time radio or spectrum data streaming.

At the start, the function sets up several buffers and variables to hold incoming data, processed results, and 
metadata. If the application is configured to run with real-time priority, it calls `set_realtime()` to attempt 
to elevate its scheduling priority, which is important for minimizing latency in real-time applications.

The main logic is contained within an infinite loop. In each iteration, the thread waits for a packet to arrive 
on the `Status_fd` socket using `recvfrom`. When a packet is received, it checks if the packet is of type 
`STATUS` and has a valid length. It then extracts the SSRC (synchronization source identifier) from the packet to 
determine which session the data belongs to.

If the SSRC indicates spectrum data (odd value), the function locates the corresponding session and updates 
status values by calling `decode_radio_status`. It then prepares an RTP (Real-time Transport Protocol) 
header and serializes various session and frontend statistics into an output buffer. The function then extracts 
power values from the received packet, processes them according to the desired precision (float, int16, or uint8), 
and writes the processed spectrum data to the client’s WebSocket. The code includes logic to rescale and auto-range 
the data for 8-bit transmission, ensuring efficient use of the available dynamic range.

If the SSRC indicates regular status data (even value), the function updates the session’s status, extracts noise density, 
and checks if the current preset and frequency match the requested values. If not, it issues commands to correct them. 
It also prepares and sends a status RTP packet to the client, including baseband power and filter edge information, 
and optionally a description string.

Throughout the function, mutexes are used to ensure thread-safe access to shared resources, such as session data 
and WebSocket connections. The code is robust, handling errors gracefully and providing debug output when necessary. 
This design allows the application to efficiently process and forward real-time radio or spectrum data to 
multiple clients, supporting features like dynamic scaling, error correction, and session management.
*/
void *ctrl_thread(void *arg) {
  struct session *sp;
  socklen_t ssize = sizeof(Metadata_source_socket);
  uint8_t buffer[PKTSIZE/sizeof(float)];
  uint8_t output_buffer[PKTSIZE];
  float powers[PKTSIZE / sizeof(float)];
  uint64_t time;
  double r_freq;
  double r_bin_bw;
//fprintf(stderr,"%s\n",__FUNCTION__);

  if (run_with_realtime)
    set_realtime();

  while(1) {
    int rx_length = recvfrom(Status_fd,buffer,sizeof(buffer),0,(struct sockaddr *)&Metadata_source_socket,&ssize);
    if(rx_length > 2 && (enum pkt_type)buffer[0] == STATUS) {
      uint32_t ssrc = get_ssrc(buffer+1,rx_length-1);
      //      fprintf(stderr,"%s: ssrc=%d\n",__FUNCTION__,ssrc);
      if(ssrc%2==1) { // Spectrum data
        if((sp=find_session_from_ssrc(ssrc-1)) != NULL){
          //      fprintf(stderr,"forward spectrum: ws=%p\n",sp->ws);

          // newell 12/1/2024, 19:07:31
          // is it kosher to call this here? It made some of the stat values
          // update more often, so I hacked it in.
          decode_radio_status(&Frontend,&Channel,buffer+1,rx_length-1);

          struct rtp_header rtp;
          memset(&rtp,0,sizeof(rtp));
          rtp.type = 0x7F; // spectrum data
          rtp.version = RTP_VERS;
          rtp.ssrc = sp->ssrc;
          rtp.marker = true; // Start with marker bit on to reset playout buffer
          rtp.seq = rtp_seq++;
          uint8_t *bp=(uint8_t *)hton_rtp((char *)output_buffer,&rtp);

          uint32_t *ip=(uint32_t*)bp;
          *ip++=htonl(sp->bins);
          *ip++=htonl(sp->center_frequency);
          *ip++=htonl(sp->frequency);
          *ip++=htonl(sp->bin_width);

          // newell 12/1/2024, 19:04:37
          // Should this be TLV encoding like the radiod RTP streams?
          // Dealing with endian and zero suppression in javascript
          // looked painful, so I went quick-n-dirty here
          memcpy((void*)ip,&Frontend.samprate,4); ip++;
          memcpy((void*)ip,&Frontend.rf_agc,4); ip++;
          memcpy((void*)ip,&Frontend.samples,8); ip+=2;
          memcpy((void*)ip,&Frontend.overranges,8); ip+=2;
          memcpy((void*)ip,&Frontend.samp_since_over,8); ip+=2;
          memcpy((void*)ip,&Frontend.timestamp,8); ip+=2;
          memcpy((void*)ip,&Channel.status.blocks_since_poll,8); ip+=2;
          memcpy((void*)ip,&Frontend.rf_atten,4); ip++;
          memcpy((void*)ip,&Frontend.rf_gain,4); ip++;
          memcpy((void*)ip,&Frontend.rf_level_cal,4); ip++;
          memcpy((void*)ip,&sp->if_power,4); ip++;
          memcpy((void*)ip,&sp->noise_density_audio,4); ip++;
          memcpy((void*)ip,&sp->zoom_index,4); ip++;
          memcpy((void*)ip,&bin_precision_bytes,4); ip++;
          memcpy((void*)ip,&sp->bins_autorange_offset,4); ip++;
          memcpy((void*)ip,&sp->bins_autorange_gain,4); ip++;

          int header_size=(uint8_t*)ip-&output_buffer[0];
          int length=(PKTSIZE-header_size)/sizeof(float);
          int npower = extract_powers(powers,length,&time,&r_freq,&r_bin_bw,sp->ssrc+1,buffer+1,rx_length-1,sp);
          if(npower < 0){
            /* char filename[256]; */
            /* sprintf(filename,"%d_%d_%08X.bin",error_count,ssrc,sp->last_poll_tag); */
            /* FILE *f = fopen(filename,"w"); */
            /* if (f) { */
            /*   fwrite(buffer,rx_length,1,f); */
            /*   fclose(f); */
            /* } */
            pthread_mutex_unlock(&session_mutex);
            continue; // Invalid for some reason
          }
          /* ++ok_count; */
          /* if (!(ok_count % 100)){ */
          /*   char filename[256]; */
          /*   sprintf(filename,"%d_%d.bin",ok_count,ssrc); */
          /*   FILE *f = fopen(filename,"w"); */
          /*   if (f) { */
          /*     fwrite(buffer,rx_length,1,f); */
          /*     fclose(f); */
          /*   } */
          /* } */
          int size;
          switch(bin_precision_bytes) {
            default:
            case 4:
            {
              float *fp=(float*)ip;
              // below center
              for(int i=npower/2; i < npower; i++) {
                *fp++=(powers[i] == 0) ? -120.0 : 10*log10(powers[i]);
              }
              // above center
              for(int i=0; i < npower/2; i++) {
                *fp++=(powers[i] == 0) ? -120.0 : 10*log10(powers[i]);
              }
              size=(uint8_t*)fp-&output_buffer[0];
            }
            break;

            case 2:
            {
              int16_t *fp=(int16_t*)ip;
              // below center
              for(int i=npower/2; i < npower; i++) {
                powers[i] = (powers[i] == 0.0) ? -327.0 : 10.0 * log10(powers[i]);
                powers[i] = (powers[i] > 327.0) ? 327.0 : powers[i];
                powers[i] = (powers[i] < -327.0) ? -327.0 : powers[i];
                *fp++=powers[i] * 100.0;
              }
              // above center
              for(int i=0; i < npower/2; i++) {
                powers[i] = (powers[i] == 0.0) ? -327.0 : 10.0 * log10(powers[i]);
                powers[i] = (powers[i] > 327.0) ? 327.0 : powers[i];
                powers[i] = (powers[i] < -327.0) ? -327.0 : powers[i];
                *fp++=powers[i] * 100.0;
              }
              size=(uint8_t*)fp-&output_buffer[0];
            }
            break;

            case 1:
            {
              // 8 bit mode, so scale bin levels to fit 0-255
              bool rescale = false;
              if (sp->bins_min_db < sp->bins_autorange_offset){
                // at least one bin would be under range, so rescale
                rescale = true;
              }
              if (sp->bins_max_db > (sp->bins_autorange_offset + (255.0 * sp->bins_autorange_gain))){
                // at least one bin would be over range, so rescale
                rescale = true;
              }
              if ((sp->bins_max_db - sp->bins_min_db) < (0.5 * (255.0 * sp->bins_autorange_gain))){
                // all bins are using less than 50% of the current range
                if ((255.0 * sp->bins_autorange_gain) > 41){
                  // and the current range is >41 dB, so rescale to fit
                  rescale = true;
                }
              }

              if (rescale){
                // pick a floor that's below the weakest bin, rounded to a 10 dB increment
                sp->bins_autorange_offset = 10.0 * (int)((sp->bins_min_db / 10.0) - 1);

                // pick a scale factor above the hottest bin, also rounded to a 10 dB increment
                sp->bins_autorange_gain = ((10.0 * (int)((sp->bins_max_db / 10.0) + 1)) - sp->bins_autorange_offset) / 255.0;
                if (sp->bins_autorange_gain == 0)
                  sp->bins_autorange_gain = 1;

                //fprintf(stderr,"offset: %.2f dB, gain: %.2f db/increment min: %.2f dBm, max: %.2f dBm, range: %.2f db fs: %.2f dBm\n", sp->bins_autorange_offset, sp->bins_autorange_gain, sp->bins_min_db, sp->bins_max_db, sp->bins_max_db - sp->bins_min_db, sp->bins_autorange_offset + (255.0 * sp->bins_autorange_gain));
              }
              uint8_t *fp=(uint8_t*)ip;
              // below center
              for(int i=npower/2; i < npower; i++) {
                powers[i] = (powers[i] == 0.0) ? -127.0 : 10.0 * log10(powers[i]);
                *fp++ = ((powers[i] - sp->bins_autorange_offset) / sp->bins_autorange_gain);       // should be 0-255 now
              }
              // above center
              for(int i=0; i < npower/2; i++) {
                powers[i] = (powers[i] == 0.0) ? -127.0 : 10.0 * log10(powers[i]);
                *fp++ = ((powers[i] - sp->bins_autorange_offset) / sp->bins_autorange_gain);       // should be 0-255 now
              }
              size=(uint8_t*)fp-&output_buffer[0];
            }
            break;
          }

          // send the spectrum data to the client
          pthread_mutex_lock(&sp->ws_mutex);
          onion_websocket_set_opcode(sp->ws,OWS_BINARY);
          int r=onion_websocket_write(sp->ws,(char *)output_buffer,size);
          if(r<=0) {
            fprintf(stderr,"%s: write failed: %d(size=%d)\n",__FUNCTION__,r,size);
          }
          pthread_mutex_unlock(&sp->ws_mutex);
          pthread_mutex_unlock(&session_mutex);
        }
      } else {
        if((sp=find_session_from_ssrc(ssrc)) != NULL){
          decode_radio_status(&Frontend,&Channel,buffer+1,rx_length-1);
          float n0 = 0.0;
          if (0 == extract_noise(&n0,buffer+1,rx_length-1,sp)){
            sp->noise_density_audio = n0;
          }
          // check to see if the preset matches our request
          if (strncmp(Channel.preset,sp->requested_preset,sizeof(sp->requested_preset))) {
            if (verbose)
              fprintf(stderr,"SSRC %u requested preset %s, but poll returned preset %s, retry preset\n",sp->ssrc,sp->requested_preset,Channel.preset);
            control_set_mode(sp,sp->requested_preset);
          }
          // verify tuned frequency is correct, too
          if (Channel.tune.freq != sp->frequency){
            if (verbose)
              fprintf(stderr,"SSRC %u requested freq %.3f kHz, but poll returned %.3f kHz, retrying...\n",
                      sp->ssrc,
                      0.001 * sp->frequency,
                      Channel.tune.freq * 0.001);
            char f[128];
            sprintf(f,"%.3f",0.001 * sp->frequency);
            control_set_frequency(sp,f);
          }
          pthread_mutex_lock(&output_dest_socket_mutex);
          if(Channel.output.dest_socket.sa_family != 0)
            pthread_cond_broadcast(&output_dest_socket_cond);
          pthread_mutex_unlock(&output_dest_socket_mutex);
          struct rtp_header rtp;
          memset(&rtp,0,sizeof(rtp));
          rtp.type = 0x7E; // radio data
          rtp.version = RTP_VERS;
          rtp.ssrc = sp->ssrc;
          rtp.marker = true; // Start with marker bit on to reset playout buffer
          rtp.seq = rtp_seq++; // ??????
          uint8_t *bp=(uint8_t *)hton_rtp((char *)output_buffer,&rtp);
          //int header_size=bp-&output_buffer[0];
          //int length=(PKTSIZE-header_size)/sizeof(float);
          encode_float(&bp,BASEBAND_POWER,Channel.sig.bb_power);
          encode_float(&bp,LOW_EDGE,Channel.filter.min_IF);
          encode_float(&bp,HIGH_EDGE,Channel.filter.max_IF);
          if (!sp->once) {
            sp->once = true;
            if (description_override)
              encode_string(&bp,DESCRIPTION,description_override,strlen(description_override));
            else
              encode_string(&bp,DESCRIPTION,Frontend.description,strlen(Frontend.description));
          }
          pthread_mutex_lock(&sp->ws_mutex);
          onion_websocket_set_opcode(sp->ws,OWS_BINARY);
          int size=(uint8_t*)bp-&output_buffer[0];
          int r=onion_websocket_write(sp->ws,(char *)output_buffer,size);
          if(r<=0) {
            fprintf(stderr,"%s: write failed: %d\n",__FUNCTION__,r);
          }
          pthread_mutex_unlock(&sp->ws_mutex);
          pthread_mutex_unlock(&session_mutex);
        }
      }
    } else if(rx_length > 2 && (enum pkt_type)buffer[0] == STATUS) {
fprintf(stderr,"%s: type=0x%02X\n",__FUNCTION__,buffer[0]);
    }
  }
//fprintf(stderr,"%s: EXIT\n",__FUNCTION__);
}
