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
#include <dlfcn.h>
//#include <stdlib.h>
#include <bsd/stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>
#include <time.h>
#include <strings.h>
#include <math.h>
#include <sys/time.h>
#include <syslog.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "misc.h"
#include "multicast.h"
#include "status.h"
#include "radio.h"
#include "config.h"

#ifndef RESOURCES_BASE_DIR
#define RESOURCES_BASE_DIR /usr/local/share/ka9q-web
#endif

/* Maximum number of concurrent websocket client sessions. Set conservatively. */
#define MAX_SESSIONS 5

/*
  Notes on recent changes (also applied to ka9q-web1/ka9q-web.c):

  - Enforce a conservative maximum concurrent websocket sessions via
    `MAX_SESSIONS`. When the server reaches capacity we now attach a
    reject callback that attempts to send a short text frame of the form
    "BUSY: <message>" and then closes the connection. This avoids creating
    a full session when resources are exhausted.

  - The rejection path (`reject_ws_cb`) writes a BUSY text frame and
    briefly sleeps (50 ms) to improve the chance the frame is flushed
    before closing. Sending a text frame then closing a websocket can be
    racey in some browser/network stacks; therefore the client-side
    JavaScript was also updated to detect "BUSY:" messages and, as a
    fallback, detect repeated short-lived open/close cycles and present a
    modal instead of continuously reconnecting.

  - Changes were mirrored in the `ka9q-web1` tree to keep behavior
    consistent across deployments. Only this file (`ka9q-web.c`) is
    documented/committed here; the `ka9q-web1` edits exist in the
    workspace but were intentionally not pushed in this commit.

  - Rationale: rejecting at the websocket handling point avoids creating
    writer threads and per-session resources for clients that cannot be
    serviced. A future improvement would be to reject at HTTP upgrade
    time with a 503/429 response to avoid the websocket upgrade/close
    race entirely.
*/

const char *webserver_version = "2.83";

/* Set to 1 to avoid performing hostname lookups for incoming clients.
  When enabled the server will record numeric IP addresses instead of
  using libonion's client description (which may perform reverse DNS).
  Toggle this constant in source to change behavior. */
const int NO_HOSTNAMES = 1;


// no handlers in /usr/local/include??
onion_handler *onion_handler_export_local_new(const char *localpath);

// Global variable to mirror Channel.tune.freq for external use
double current_backend_frequency = 0.0;

int Ctl_fd = -1, Input_fd = -1, Status_fd = -1;
pthread_mutex_t ctl_mutex;
pthread_t ctrl_task;
pthread_t audio_task;
pthread_t ws_ping_task;
pthread_t ws_watchdog_task;
/* monitor removed: previously guarded by ENABLE_MONITOR */
pthread_mutex_t output_dest_socket_mutex;
pthread_cond_t output_dest_socket_cond;
/* microseconds to sleep after successful control send to avoid overrunning backend */
#define CONTROL_USLEEP_US 10000 // minimum of 20 ms observed for backend to process a command and update status, so 30 ms is a safe default

struct session {
  bool spectrum_active;
  bool audio_active;
  onion_websocket *ws;
  int ws_fd; /* underlying websocket socket fd, or -1 if unknown */
  pthread_mutex_t ws_mutex;
  uint32_t ssrc;
  bool write_in_progress;
  unsigned long last_write_start_ms;
  pthread_t poll_task;
  pthread_t spectrum_task;
  pthread_mutex_t spectrum_mutex;
  useconds_t spectrum_poll_us; /* per-session poll interval (microseconds) */
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
  float noise_density_audio;
  float if_power;
  int zoom_index;
  char requested_preset[32];
  float bins_min_db;
  float bins_max_db;
  int freq_mismatch_count; /* counts consecutive status cycles with freq mismatch */
  int preset_mismatch_count; /* counts consecutive status cycles with preset mismatch */
  float spectrum_base;
  float spectrum_step;
  double shift; /* per-session post-detection audio frequency shift, Hz */
  unsigned long last_client_command_ms; /* monotonic ms when local web client last issued freq/mode */
  unsigned long reattach_time_ms; /* monotonic ms when a websocket was reattached to this session */
  unsigned long spectrum_restart_quiet_until_ms; /* monitor cooldown until this ms */
    unsigned long last_spectrum_recv_ms; /* monotonic ms when last spectrum TLV received */
    bool spectrum_requested_by_client; /* true if client requested spectrum */
    int spectrum_restart_attempts;    /* number of restart attempts made */
    unsigned long last_spectrum_restart_ms; /* monotonic ms of last restart attempt */
    /* If the client recently commanded a mode change leaving CWU/CWL, this
      flag records that event so we can adopt the backend frequency when the
      backend clears the CW shift. `left_cw_time_ms` is the monotonic time in
      milliseconds when the client requested the change; `left_cw_prev_preset`
      stores the previous preset name (e.g., "cwu"/"cwl"). */
    int left_cw_pending;
    unsigned long left_cw_time_ms;
    char left_cw_prev_preset[8];
    /* If the client recently toggled between CWU and CWL (flip), mark a
       short-lived pending flag so the status packet handler can adopt the
       backend frequency when the backend shifts the carrier by the expected
       doubled-shift amount. */
    int cw_flip_pending;
    unsigned long cw_flip_time_ms;
    char cw_flip_prev_preset[8];
    bool opus_active; /* true when client has requested Opus encoding */
    /* Outgoing websocket queue and writer thread */
    struct ws_msg *out_head;
    struct ws_msg *out_tail;
    pthread_mutex_t out_mutex;
    pthread_cond_t out_cond;
    pthread_t writer_task;
    bool writer_running;
  /* uint32_t last_poll_tag; */
};

#define START_SESSION_ID 1000

int init_connections(const char *multicast_group);
extern int init_control(struct session *sp);
extern void control_set_frequency(struct session *sp,char *str);
extern void control_set_mode(struct session *sp,char *str);
extern void control_set_shift(struct session *sp,char *str);
extern void control_set_filter_edges(struct session *sp, char *low_str, char *high_str);
extern void control_set_spectrum_average(struct session *sp, char *val_str);
extern void control_set_spectrum_overlap(struct session *sp, char *val_str);
extern void control_set_window_type(struct session *sp, char *type_str, char *shape_str);
extern void control_set_encoding(struct session *sp, bool use_opus);
int init_demod(struct channel *channel);
void control_get_powers(struct session *sp,float frequency,int bins,float bin_bw);
void stop_spectrum_stream(struct session *sp);
int extract_powers(float *power,int npower,uint64_t *time,double *freq,double *bin_bw,int32_t const ssrc,uint8_t const * const buffer,int length,struct session *sp);
void control_poll(struct session *sp);
void *spectrum_thread(void *arg);
void *ctrl_thread(void *arg);

/* websocket send helpers (forward declarations) */
static void send_ws_binary_to_session(struct session *sp, uint8_t *buf, int size);
static void send_ws_text_to_session(struct session *sp, const char *msg);
static void *ws_ping_thread(void *arg);
/* Reject-callback for new websockets when the server is at capacity. */
static onion_connection_status reject_ws_cb(void *data, onion_websocket *ws, long int unused) {
  (void)unused;
  const char *msg = "BUSY: server at capacity; try again later";
  onion_websocket_set_opcode(ws, OWS_TEXT);
  onion_websocket_write(ws, msg, strlen(msg));
  /* allow a short time for the frame to flush to the socket before closing */
  usleep(50000); /* 50 ms */
  return OCS_CLOSE_CONNECTION;
}
/* Outgoing message node for per-session queue */
struct ws_msg {
  uint8_t *data;
  int size;
  int is_text; /* 1 => text, 0 => binary */
  struct ws_msg *next;
};

/* Per-session writer helpers (defined below) */
static void enqueue_ws_message(struct session *sp, const uint8_t *buf, int size, int is_text);
static void free_out_queue(struct session *sp);
static void *session_writer_thread(void *arg);
/* Forward declarations used by watchdog (defined later) */
static unsigned long now_ms(void);
extern pthread_mutex_t session_mutex;
/* Helper to obtain request fd from libonion if available at runtime. Uses dlsym
   to avoid link-time dependency on a particular libonion version. */
static int get_request_fd(void *req) {
  typedef int (*getfd_fn_t)(void *);
  static getfd_fn_t fn = NULL;
  if (fn == NULL) {
    fn = (getfd_fn_t)dlsym(RTLD_DEFAULT, "onion_request_get_fd");
    if (fn == NULL)
      return -1;
  }
  return fn(req);
}

/* Helper: obtain a short client description. When `NO_HOSTNAMES` is set
   prefer a numeric IP string (avoids reverse DNS lookups). Returns a
   pointer to `buf` when a numeric address is produced, otherwise falls
   back to libonion's `onion_request_get_client_description()` result. */
static const char *client_desc_from_request(void *req, char *buf, size_t buflen) {
  if (!NO_HOSTNAMES) {
    return onion_request_get_client_description((onion_request*)req);
  }
  int fd = get_request_fd(req);
  if (fd >= 0) {
    struct sockaddr_storage addr;
    socklen_t len = sizeof(addr);
    if (getpeername(fd, (struct sockaddr *)&addr, &len) == 0) {
      if (addr.ss_family == AF_INET) {
        struct sockaddr_in *a = (struct sockaddr_in *)&addr;
        if (inet_ntop(AF_INET, &a->sin_addr, buf, buflen)) {
          return buf;
        }
      } else if (addr.ss_family == AF_INET6) {
        struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)&addr;
        if (inet_ntop(AF_INET6, &a6->sin6_addr, buf, buflen)) {
          return buf;
        }
      }
    }
  }
  /* Fallback to libonion description if numeric form unavailable */
  const char *desc = onion_request_get_client_description((onion_request*)req);
  if (desc && desc[0] != '\0') return desc;
  strncpy(buf, "unknown", buflen);
  buf[buflen-1] = '\0';
  return buf;
}
/* Tentative declarations so watchdog can reference them before the real defs */
static int nsessions;
static struct session *sessions;
/* Forward declaration so ws_watchdog_thread can call delete_session without implicit declaration warning */
void delete_session(struct session *sp);

struct frontend Frontend;
struct sockaddr Metadata_source_socket;       // Source of metadata
struct sockaddr Metadata_dest_socket;         // Dest of metadata (typically multicast)

static int const DEFAULT_IP_TOS = 48;

/* watchdog: detect websocket write operations that have blocked for too long
   and recover by cleaning up the session (similar to a write failure). */
extern int debug_send;
static void *ws_watchdog_thread(void *arg) {
  (void)arg;
  const unsigned long threshold_ms = 500; /* consider write stuck after 500ms */
  for (;;) {
    usleep(100 * 1000); /* 100 ms */
    unsigned long now = now_ms();
    /* Collect sessions snapshot */
    pthread_mutex_lock(&session_mutex);
    int n = nsessions;
    struct session **list = NULL;
    if (n > 0) {
      list = calloc(n, sizeof(*list));
      int i = 0;
      struct session *sp = sessions;
      while (sp != NULL && i < n) {
        list[i++] = sp;
        sp = sp->next;
      }
      n = i;
    }
    pthread_mutex_unlock(&session_mutex);

    for (int i = 0; i < n; ++i) {
      struct session *sp = list[i];
      pthread_t spectrum_join = 0;
      /* Read write flags without taking ws_mutex to avoid blocking if a writer
         thread is stuck holding that mutex. This is racy but acceptable for
         watchdog recovery: detection only needs to be approximate. */
      if (sp->write_in_progress) {
        /* Sanity-check timestamp to avoid unsigned wrap when clocks/domain
           mismatches or uninitialized values occur. If `last_write_start_ms`
           is zero or appears to be in the future relative to `now`, skip
           age calculation and wait for a sane value. */
        if (sp->last_write_start_ms == 0 || sp->last_write_start_ms > now) {
          if (debug_send) {
            fprintf(stderr, "ws_watchdog: skipping age calc for ssrc=%u last_write_start_ms=%lu now=%lu\n", sp->ssrc, sp->last_write_start_ms, now);
          }
          continue;
        }
        unsigned long age = now - sp->last_write_start_ms;
        if (age > threshold_ms) {
          fprintf(stderr, "ws_watchdog: write stuck for %lums on ssrc=%u, cleaning session\n", age, sp->ssrc);
          /* Perform recovery while holding session_mutex so we do not race
               with session list operations. We intentionally avoid locking
               sp->ws_mutex here to prevent deadlock against the blocked writer. */
            pthread_mutex_lock(&session_mutex);
            control_set_frequency(sp, "0");
            sp->audio_active = false;
            if (sp->spectrum_active) {
              pthread_mutex_lock(&sp->spectrum_mutex);
              sp->spectrum_active = false;
              stop_spectrum_stream(sp);
              spectrum_join = sp->spectrum_task;
              pthread_mutex_unlock(&sp->spectrum_mutex);
            }
            sp->spectrum_requested_by_client = false;
            sp->spectrum_restart_attempts = 0;
            sp->last_spectrum_restart_ms = 0;
            sp->write_in_progress = false;
            /* Remove the stuck session entirely so reconnects create a fresh
               session and spectrum can be restarted cleanly. `delete_session`
               expects `session_mutex` to be held and will release it before
               joining the writer thread. */
            delete_session(sp);
            if (spectrum_join) pthread_join(spectrum_join, NULL);
        }
      }
    }
    free(list);
  }
  return NULL;
}
static int const DEFAULT_MCAST_TTL = 1;

uint64_t Metadata_packets;
struct channel Channel;
uint64_t Block_drops;
int Mcast_ttl = DEFAULT_MCAST_TTL;
int IP_tos = DEFAULT_IP_TOS;
const char *App_path;
int64_t Timeout = BILLION;
int ConnTimeoutSeconds = 60; /* seconds; 0 == wait forever */
uint16_t rtp_seq=0;
int verbose = 0;
/* Gate extra SSRC/session debug prints to avoid console flooding */
int debugSSRC = 0;
int debug_ws_ping = 0; /* gate for ws_ping verbose prints */
/* If true, emit extra send debugging output (gated with `verbose`). */
int debug_send = 1;
int debug_send_poll = 0;
/* Low-volume global send-success counter for temporary debugging (removed) */
/* Poll-cycle start time (ms since monotonic epoch). Reset when poll count starts/resets. */
static unsigned long poll_start_ms = 0;
/* Monotonic ms timestamp of last successful status packet recv */
static unsigned long last_status_recv_ms = 0;
/* Monotonic ms timestamp of last successful audio packet recv */
static unsigned long last_audio_recv_ms = 0;

/* Forward declaration: monotonic time in milliseconds helper */
static unsigned long now_ms(void);

/* Forward declarations for session globals referenced by monitor_thread */
static int nsessions; /* defined later with initializer */
static struct session *sessions; /* defined later with initializer */
extern pthread_mutex_t session_mutex;

/* monitor removed */

/* Helper: monotonic time in milliseconds */
static unsigned long now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
    return (unsigned long)time(NULL) * 1000UL;
  return (unsigned long)(ts.tv_sec * 1000UL + ts.tv_nsec / 1000000UL);
}

/* If no build-time `GIT_COMMIT` is embedded, provide a runtime fallback that
   reads the short commit from the local git metadata. This helper is omitted
   when `GIT_COMMIT` is defined to avoid unused-function warnings. */
#ifndef GIT_COMMIT
/* Keep this helper available for optional future startup logging, but avoid
  -Wunused-function warnings when no call site is compiled. */
__attribute__((unused))
static void log_git_commit_runtime(void) {
  char buf[128];
  FILE *f = popen("git rev-parse --short HEAD 2>/dev/null", "r");
  if (f) {
    if (fgets(buf, sizeof(buf), f)) {
      buf[strcspn(buf, "\r\n")] = '\0';
      syslog(LOG_INFO, "ka9q-web commit: %s", buf);
    } else {
      syslog(LOG_INFO, "ka9q-web commit: unknown");
    }
    pclose(f);
  } else {
    syslog(LOG_INFO, "ka9q-web commit: unknown");
  }
}
#endif

#ifndef GIT_COMMIT_INDEX
static void log_git_commit_index_runtime(void) {
  char ibuf[64];
  FILE *f = popen("git rev-list --count HEAD 2>/dev/null", "r");
  if (f) {
    if (fgets(ibuf, sizeof(ibuf), f)) {
      ibuf[strcspn(ibuf, "\r\n")] = '\0';
      syslog(LOG_INFO, "ka9q-web commit-index: %s", ibuf);
    } else {
      syslog(LOG_INFO, "ka9q-web commit-index: unknown");
    }
    pclose(f);
  } else {
    syslog(LOG_INFO, "ka9q-web commit-index: unknown");
  }
}
#endif
/* Adopt-on-parameter-mismatch control removed from clients; server adoption
  decisions are now driven by backend-reported post-detection shift values. */
/* Preset mismatch auto-acceptance removed: server will not auto-correct presets */
/* Adopt-on-parameter-mismatch control removed from clients; server adoption
  decisions are now driven by backend-reported post-detection shift values. */
/* Preset mismatch auto-acceptance removed: server will not auto-correct presets */
/* static int error_count = 0; */
/* static int ok_count = 0; */

/* sleep time for spectrum polling and related retries (microseconds) */
useconds_t spectrum_poll_us = 100000; // default 100 ms

#define MAX_BINS 1620

onion_connection_status websocket_cb(void *data, onion_websocket * ws,
                                               ssize_t data_ready_len);

/* Forward declarations for static helpers used by handle_ws_message */
static void check_frequency(struct session *sp);
static void zoom_to(struct session *sp, int level);
static void zoom(struct session *sp, int shift);
static void adjust_center_within_bounds(struct session *sp);
/* Define zoom_table type and table so handler can compute size */
struct zoom_table_t {
  int bin_width;
  int bin_count;
};

const struct zoom_table_t zoom_table[] = {
  {40000, 1620},
  {20000, 1620},
  {10000, 1620},
  {8000, 1620},
  {5000, 1620},
  {4000, 1620},
  {2000, 1620},
  {1000, 1620},
  {800, 1620},
  {500, 1620},
  {400, 1620},
  {200, 1620},
  {100, 1620},
  {80, 1620},
  {50, 1620},
  {40, 1620},
  {20, 1620},
  {10, 1620},
  {8, 1620},
  {5, 1620},
  {4, 1620},
  {2, 1620},
  {1, 1620}
};

/* Dispatch a single websocket text message `tmp` for session `sp`.
   Called with `session_mutex` already held. Returns an Onion status. */
static onion_connection_status handle_ws_message(struct session *sp, char *tmp) {
  char *saveptr = NULL;
  char *token = strtok_r(tmp, ":", &saveptr);
  if (token == NULL) {
    return OCS_NEED_MORE_DATA;
  }
  if (strlen(token) == 1) {
    switch (*token) {
      case 'S':
      case 's':
        {
          char temp[16];
          snprintf(temp, sizeof(temp), "S:%d", sp->ssrc);
          send_ws_text_to_session(sp, temp);
          if (debugSSRC) fprintf(stderr, "ws: S: request from ssrc %u\n", sp->ssrc);
          sp->spectrum_requested_by_client = true;
          sp->spectrum_restart_attempts = 0;
          sp->last_spectrum_restart_ms = 0;
          if(pthread_create(&sp->spectrum_task,NULL,spectrum_thread,sp) == -1){
            perror("pthread_create: spectrum_thread");
          } else {
            char buff[16];
            snprintf(buff,16,"spec_%u",sp->ssrc+1);
            pthread_setname_np(sp->spectrum_task, buff);
          }
        }
        break;
      case 'A':
      case 'a':
        token = strtok_r(NULL, ":", &saveptr);
        if(token && strcmp(token,"START")==0) {
          sp->audio_active=true;
        } else if(token && strcmp(&tmp[2],"STOP")==0) {
          sp->audio_active=false;
        }
        break;
      case 'O':
      case 'o':
        token = strtok_r(NULL, ":", &saveptr);
        if(token && strcasecmp(token,"OPUS")==0) {
          sp->opus_active=true;
          control_set_encoding(sp,true);
        } else if(token && strcasecmp(token,"PCM")==0) {
          sp->opus_active=false;
          control_set_encoding(sp,false);
        }
        break;
      case 'e':
      case 'E':
        {
          char *low = strtok_r(NULL, ":", &saveptr);
          char *high = strtok_r(NULL, ":", &saveptr);
          if (low != NULL && high != NULL) {
            control_set_filter_edges(sp, low, high);
          }
        }
        break;
      case 'g':
      case 'G':
        {
          char *avg = strtok_r(NULL, ":", &saveptr);
          if (avg != NULL) {
            control_set_spectrum_average(sp, avg);
            fflush(stderr);
          }
        }
        break;
      case 'w':
      case 'W':
        {
          char *type = strtok_r(NULL, ":", &saveptr);
          char *param = strtok_r(NULL, ":", &saveptr);
          if (type != NULL) {
            control_set_window_type(sp, type, param ? param : "");
          }
        }
        break;
      case 'v':
      case 'V':
        {
          char *ov = strtok_r(NULL, ":", &saveptr);
          if (ov != NULL) {
            control_set_spectrum_overlap(sp, ov);
            fflush(stderr);
          }
        }
        break;
      case 'F':
      case 'f':
        sp->frequency = (uint32_t)lround(strtod(&tmp[2],0) * 1000.0);
        {
          int32_t span = sp->bin_width * sp->bins;
          int32_t min_f = sp->center_frequency - (span / 2);
          int32_t max_f = sp->center_frequency + (span / 2);
          int32_t edge_outside_margin_frequency = 50 * sp->bin_width;
          int32_t edge_bin_margin = 30;
          if (sp->frequency < min_f + edge_bin_margin * sp->bin_width) {
            if ((min_f + edge_bin_margin * sp->bin_width) - sp->frequency <= edge_outside_margin_frequency) {
              int32_t shift = ((min_f + edge_bin_margin * sp->bin_width - sp->frequency + sp->bin_width - 1) / sp->bin_width);
              sp->center_frequency -= shift * sp->bin_width;
            } else {
              sp->center_frequency = sp->frequency;
            }
          } else if (sp->frequency > max_f - edge_bin_margin * sp->bin_width) {
            if (sp->frequency - (max_f - edge_bin_margin * sp->bin_width) <= edge_outside_margin_frequency) {
              int32_t shift = ((sp->frequency - (max_f - edge_bin_margin * sp->bin_width) + sp->bin_width - 1) / sp->bin_width);
              sp->center_frequency += shift * sp->bin_width;
            } else {
              sp->center_frequency = sp->frequency;
            }
          }
        }
        check_frequency(sp);
        sp->last_client_command_ms = now_ms();
        control_set_frequency(sp,&tmp[2]);
        break;
      case 'M':
      case 'm':
        {
          char prev_requested[32];
          strlcpy(prev_requested, sp->requested_preset, sizeof(prev_requested));
          char *new_preset = &tmp[2];
          if ((strncasecmp(prev_requested, "cwu", 3) == 0 || strncasecmp(prev_requested, "cwl", 3) == 0)
              && !(strncasecmp(new_preset, "cwu", 3) == 0 || strncasecmp(new_preset, "cwl", 3) == 0)) {
            sp->left_cw_pending = 1;
            sp->left_cw_time_ms = now_ms();
            strlcpy(sp->left_cw_prev_preset, prev_requested, sizeof(sp->left_cw_prev_preset));
            if (verbose)
              fprintf(stderr, "SSRC %u: marked recent CW->non-CW preset change (prev=%s)\n", sp->ssrc, prev_requested);
          }
          else if ((strncasecmp(prev_requested, "cwu", 3) == 0 || strncasecmp(prev_requested, "cwl", 3) == 0)
                   && (strncasecmp(new_preset, "cwu", 3) == 0 || strncasecmp(new_preset, "cwl", 3) == 0)
                   && strncasecmp(prev_requested, new_preset, 3) != 0) {
            sp->cw_flip_pending = 1;
            sp->cw_flip_time_ms = now_ms();
            strlcpy(sp->cw_flip_prev_preset, prev_requested, sizeof(sp->cw_flip_prev_preset));
            if (verbose)
              fprintf(stderr, "SSRC %u: marked recent CW flip preset change (prev=%s new=%s)\n", sp->ssrc, prev_requested, new_preset);
          }
        }
        sp->last_client_command_ms = now_ms();
        control_set_mode(sp,&tmp[2]);
        control_poll(sp);
        break;
      case 'T':
      case 't':
        control_set_shift(sp, &tmp[2]);
        break;
      /* 'P' (adopt-on-mismatch) messages removed: adoption is now server-driven */
      case 'R':
      case 'r':
        {
          char *endptr;
          long v = strtol(&tmp[2], &endptr, 10);
          if (&tmp[2] != endptr && v > 0) {
            pthread_mutex_lock(&sp->spectrum_mutex);
            sp->spectrum_poll_us = (useconds_t)(v * 1000L);
            pthread_mutex_unlock(&sp->spectrum_mutex);
            if (verbose)
              fprintf(stderr, "%s: set sp->spectrum_poll_us to %u us (from %ld ms)\n", __FUNCTION__, (unsigned)sp->spectrum_poll_us, v);
          }
        }
        break;
      case 'Z':
      case 'z':
        token=strtok_r(NULL,":", &saveptr);
        if(token && strcmp(token,"+")==0) {
          pthread_mutex_lock(&sp->spectrum_mutex);
          zoom(sp,1);
          pthread_mutex_unlock(&sp->spectrum_mutex);
          check_frequency(sp);
        } else if(token && strcmp(token,"-")==0) {
          pthread_mutex_lock(&sp->spectrum_mutex);
          zoom(sp,-1);
          pthread_mutex_unlock(&sp->spectrum_mutex);
          check_frequency(sp);
        } else if(token && strcmp(token,"c")==0) {
          token = strtok_r(NULL,":", &saveptr);
          if (token)
          {
            char *endptr;
            double f = strtod(token,&endptr) * 1000.0;
            if (token != endptr) {
              sp->center_frequency = f;
            }
          }
       adjust_center_within_bounds(sp);
          pthread_mutex_lock(&sp->spectrum_mutex);
          control_get_powers(sp,(float)sp->center_frequency,sp->bins,(float)sp->bin_width);
          pthread_mutex_unlock(&sp->spectrum_mutex);
          control_poll(sp);
        } else if (token && strcmp(token, "SIZE") == 0) {
            int table_size = sizeof(zoom_table) / sizeof(zoom_table[0]);
            char response[16];
            snprintf(response, sizeof(response), "ZSIZE:%d", table_size);
            send_ws_text_to_session(sp, response);
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
      case 'C':
      case 'c':
        {
          /* Expect format: C:<clientId>:<seq>:<payload...> */
          char *client = strtok_r(NULL, ":", &saveptr);
          char *seq = strtok_r(NULL, ":", &saveptr);
          char *payload = saveptr; /* rest of string */
          if (client != NULL && seq != NULL && payload != NULL && *payload != '\0') {
            /* Process the inner payload as a separate message (use a copy to avoid tokenizer conflicts) */
            char *payload_copy = strdup(payload);
            if (payload_copy) {
              handle_ws_message(sp, payload_copy);
              free(payload_copy);
            }
            /* Send ACK back to the originating websocket */
            char ackbuf[256];
            snprintf(ackbuf, sizeof(ackbuf), "ACK:%s:%s", client, seq);
            send_ws_text_to_session(sp, ackbuf);
          }
        }
        break;
    }
  }
  return OCS_NEED_MORE_DATA;
}

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
  /* Ensure per-session spectrum/restart fields are deterministic */
  sp->last_spectrum_recv_ms = 0;
  sp->ws_fd = -1;
  sp->spectrum_requested_by_client = false;
  sp->spectrum_restart_attempts = 0;
  sp->last_spectrum_restart_ms = 0;
  sp->write_in_progress = false;
  sp->last_write_start_ms = 0;

  pthread_mutex_lock(&session_mutex);
  if(sessions==NULL) {
    sessions=sp;
  } else {
    sessions->previous=sp;
    sp->next=sessions;
    sessions=sp;
  }
  nsessions++;
  /* Initialize outgoing queue and start writer thread for this session */
  sp->out_head = sp->out_tail = NULL;
  pthread_mutex_init(&sp->out_mutex, NULL);
  pthread_cond_init(&sp->out_cond, NULL);
  sp->writer_running = true;
  if (pthread_create(&sp->writer_task, NULL, session_writer_thread, sp) == -1) {
    perror("pthread_create: session_writer_thread");
    sp->writer_running = false;
  }
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
  /* Stop writer thread without holding session_mutex while joining it.
     Holding session_mutex during pthread_join can deadlock if the writer
     thread attempts to acquire session_mutex while cleaning up a blocked
     write. To avoid that, signal the writer to stop, release
     session_mutex, then join the writer. */
  bool need_join = false;
  if (sp->writer_running) {
    need_join = true;
    pthread_mutex_lock(&sp->out_mutex);
    sp->writer_running = false;
    pthread_cond_signal(&sp->out_cond);
    pthread_mutex_unlock(&sp->out_mutex);
  }
  /* Release session list lock before waiting for writer to exit. */
  pthread_mutex_unlock(&session_mutex);

  if (need_join)
    pthread_join(sp->writer_task, NULL);

  free_out_queue(sp);
  pthread_mutex_destroy(&sp->out_mutex);
  pthread_cond_destroy(&sp->out_cond);
  free(sp);
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
  pthread_t spectrum_join = 0;
  pthread_mutex_lock(&sp->ws_mutex);
  control_set_frequency(sp,"0");
  sp->audio_active=false;
  if(sp->spectrum_active) {
    pthread_mutex_lock(&sp->spectrum_mutex);
    sp->spectrum_active=false;
    stop_spectrum_stream(sp);
    spectrum_join = sp->spectrum_task;
    pthread_mutex_unlock(&sp->spectrum_mutex);
  }
  /* Client disconnected: mark that client no longer requests spectrum */
  sp->spectrum_requested_by_client = false;
  sp->spectrum_restart_attempts = 0;
  sp->last_spectrum_restart_ms = 0;
  pthread_mutex_unlock(&sp->ws_mutex);
  if (spectrum_join) pthread_join(spectrum_join, NULL);
}

static void check_frequency(struct session *sp) {
    if(sp->bins == 0 || sp->bin_width == 0 || Frontend.samprate == 0)
      return;

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

static void zoom_to(struct session *sp, int level) {
  const int table_size = sizeof(zoom_table) / sizeof(zoom_table[0]);

  if (level < 0)
    level = 0;

  if(Frontend.samprate != 0){
    while(zoom_table[level].bin_width * zoom_table[level].bin_count
	  > Frontend.samprate/2 && level < table_size)
      level++;
    if(level == table_size)
      level--;
  }
  sp->bin_width = zoom_table[level].bin_width;
  sp->bins = zoom_table[level].bin_count;
  sp->zoom_index = level;
}

static void zoom(struct session *sp, int shift) {
  zoom_to(sp, sp->zoom_index + shift);
}

/* Clamp center frequency so the visible span stays within [0, fs/2]
   but do not force the tuned frequency to be inside the visible window. */
static void adjust_center_within_bounds(struct session *sp) {
  if(sp->bin_width == 0 || sp->bins == 0 || Frontend.samprate == 0)
    return;

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

/* websocket ping thread: iterate sessions and send short text PINGs */
static void *ws_ping_thread(void *arg) {
  (void)arg;
  unsigned long iter = 0;
  if (debug_ws_ping) fprintf(stderr, "ws_ping: started\n");
  for (;;) {
    usleep(500000); /* 0.5s */
    pthread_mutex_lock(&session_mutex);
    struct session *sp = sessions;
    int n = 0;
    struct session *list[64];
    while (sp != NULL && n < (int)(sizeof(list)/sizeof(list[0]))) {
      list[n++] = sp;
      sp = sp->next;
    }
    pthread_mutex_unlock(&session_mutex);

    for (int i = 0; i < n; ++i) {
      struct session *ssp = list[i];
      send_ws_text_to_session(ssp, "PING");
    }

    if (debug_ws_ping) fprintf(stderr, "ws_ping: iter=%lu sessions=%d\n", iter, n);
    iter++;
  }
  return NULL;
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

  // Debug: log incoming websocket text for troubleshooting message ordering
  if(verbose) {
    if (len > 0 && tmp[0] != '\0') {
      fprintf(stderr, "%s: received websocket text: '%s'\n", __FUNCTION__, tmp);
    }
  }


  //ONION_INFO("Read from websocket: %d: %s", len, tmp);


  onion_connection_status rc = handle_ws_message(sp, tmp);
  pthread_mutex_unlock(&session_mutex);

  return rc;
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
  /* Open syslog and record the current git commit index. Prefer the build-time
     embedded `GIT_COMMIT_INDEX` if available; otherwise fall back to runtime git. */
  openlog(App_path, LOG_PID|LOG_CONS, LOG_USER);
#ifdef GIT_COMMIT_INDEX
  syslog(LOG_INFO, "ka9q-web commit-index: %s (build)", GIT_COMMIT_INDEX);
#else
  log_git_commit_index_runtime();
#endif

  /* Print commit index to stdout for visibility on startup. If not embedded,
     query the local git metadata as a fallback. */
#ifdef GIT_COMMIT_INDEX
  printf("ka9q-web commit-index: %s\n", GIT_COMMIT_INDEX);
#else
  {
    char ibuf[64];
    FILE *fidx = popen("git rev-list --count HEAD 2>/dev/null", "r");
    if (fidx) {
      if (fgets(ibuf, sizeof(ibuf), fidx)) {
        ibuf[strcspn(ibuf, "\r\n")] = '\0';
        printf("ka9q-web commit-index: %s\n", ibuf);
      } else {
        printf("ka9q-web commit-index: unknown\n");
      }
      pclose(fidx);
    } else {
      printf("ka9q-web commit-index: unknown\n");
    }
  }
#endif
  {
    int c;
    while((c = getopt(argc,argv,"d:p:m:hn:vb:rT:")) != -1){
      switch(c) {
      case 'T':
        ConnTimeoutSeconds = atoi(optarg);
        if (ConnTimeoutSeconds < 0) ConnTimeoutSeconds = 0;
        break;
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

  /* Allow enabling extra debug via environment variables to avoid recompiles:
     KA9Q_DEBUGSSRC=1  -> enable SSRC/session debug prints
     KA9Q_DEBUGSEND=1  -> enable send-path debug prints
  */
  {
    char *e;
    if ((e = getenv("KA9Q_DEBUGSSRC")) && atoi(e)) {
      debugSSRC = 1;
      fprintf(stderr, "Debug: KA9Q_DEBUGSSRC enabled\n");
    }
    if ((e = getenv("KA9Q_DEBUGSEND")) && atoi(e)) {
      debug_send = 1;
      fprintf(stderr, "Debug: KA9Q_DEBUGSEND enabled\n");
    }
    if ((e = getenv("KA9Q_DEBUG_WSPING")) && atoi(e)) {
      debug_ws_ping = 1;
      fprintf(stderr, "Debug: KA9Q_DEBUG_WSPING enabled\n");
    }
  }

  /* Allow enabling extra debug via environment variables to avoid recompiles:
     KA9Q_DEBUGSSRC=1  -> enable SSRC/session debug prints
     KA9Q_DEBUGSEND=1  -> enable send-path debug prints
  */
  {
    char *e;
    if ((e = getenv("KA9Q_DEBUGSSRC")) && atoi(e)) {
      debugSSRC = 1;
      fprintf(stderr, "Debug: KA9Q_DEBUGSSRC enabled\n");
    }
    if ((e = getenv("KA9Q_DEBUGSEND")) && atoi(e)) {
      debug_send = 1;
      fprintf(stderr, "Debug: KA9Q_DEBUGSEND enabled\n");
    }
    if ((e = getenv("KA9Q_DEBUG_WSPING")) && atoi(e)) {
      debug_ws_ping = 1;
      fprintf(stderr, "Debug: KA9Q_DEBUG_WSPING enabled\n");
    }
  }

  fprintf(stderr, "ka9q-web version: v%s\n", webserver_version);
  pthread_mutex_init(&session_mutex,NULL);
  if (init_connections(mcast) != EX_OK) {
    fprintf(stderr, "Failed to initialize multicast connections; exiting\n");
    return EX_IOERR;
  }
  /* Send default spectrum averaging to backend at startup (default 10) */
  control_set_spectrum_average(NULL, "10");
    /* Do not send a default spectrum overlap at startup; prefer client-provided value.
      control_set_spectrum_overlap(NULL, "0.5"); */
  onion *o = onion_new(O_THREADED | O_NO_SIGTERM);
  onion_url *urls=onion_root_url(o);
  onion_set_port(o, port);
  onion_set_hostname(o, "::");
  onion_handler *pages = onion_handler_export_local_new(dirname);
  onion_handler_add(onion_url_to_handler(urls), pages);
  onion_url_add(urls, "status", status);
  onion_url_add(urls, "version.json", version);
  onion_url_add(urls, "^$", home);

  /* Start websocket ping thread to detect dead clients (sends "PING" every 2s) */
  if (pthread_create(&ws_ping_task, NULL, ws_ping_thread, NULL) != 0) {
    fprintf(stderr, "Failed to start ws_ping_thread\n");
  }
  /* Start websocket watchdog thread to detect stuck writes */
  if (pthread_create(&ws_watchdog_task, NULL, ws_watchdog_thread, NULL) != 0) {
    fprintf(stderr, "Failed to start ws_watchdog_thread\n");
  }

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
        "  <title>KA9Q Web SDR - Status</title>"
        "  <meta charset=\"UTF-8\" />"
        "  <meta http-equiv=\"refresh\" content=\"30\" />"
        "</head>"
        "<body>"
        "  <h1>KA9Q Web SDR - Status</h1>");
    sprintf(text,"<b>Sessions: %d</b>",nsessions);
    onion_response_write0(res, text);

    /* Show last status packet receive time */
    if (last_status_recv_ms == 0) {
      onion_response_write0(res, "<p><b>Last status recv:</b> never</p>");
    } else {
      unsigned long ago = now_ms() - last_status_recv_ms;
      char tbuf[128];
      snprintf(tbuf, sizeof(tbuf), "<p><b>Last status recv:</b> %lu ms ago</p>", ago);
      onion_response_write0(res, tbuf);
    }

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
          "<th>Last spectrum recv</th>"
          "<th>Audio</th>"
          "</tr>");

      /* Protect iteration over the global sessions list */
      pthread_mutex_lock(&session_mutex);
      struct session *sp = sessions;
      while(sp!=NULL) {
        int32_t min_f=sp->center_frequency-((sp->bin_width*sp->bins)/2);
        int32_t max_f=sp->center_frequency+((sp->bin_width*sp->bins)/2);
        char specbuf[64];
        {
          unsigned long now_s = now_ms();
          if (sp->last_spectrum_recv_ms == 0 || sp->last_spectrum_recv_ms > now_s) {
            snprintf(specbuf, sizeof(specbuf), "never");
          } else {
            unsigned long spec_age = now_s - sp->last_spectrum_recv_ms;
            const unsigned long MAX_DISPLAY_AGE_MS = 24UL * 60UL * 60UL * 1000UL;
            if (spec_age > MAX_DISPLAY_AGE_MS) spec_age = MAX_DISPLAY_AGE_MS;
            snprintf(specbuf, sizeof(specbuf), "%lu ms ago", spec_age);
          }
        }
        sprintf(text,"<tr><td>%s</td><td>%d</td><td>%d to %d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td><td>%s</td><td>%s</td></tr>",
                sp->client,sp->ssrc,min_f,max_f,sp->frequency,sp->center_frequency,sp->bins,sp->bin_width,specbuf,sp->audio_active?"Enabled":"Disabled");
        onion_response_write0(res, text);
        sp=sp->next;
      }
      pthread_mutex_unlock(&session_mutex);
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
    char idx[64] = "unknown";
#ifdef GIT_COMMIT_INDEX
    strncpy(idx, GIT_COMMIT_INDEX, sizeof(idx)-1);
    idx[sizeof(idx)-1] = '\0';
#else
    {
      FILE *f = popen("git rev-list --count HEAD 2>/dev/null", "r");
      if (f) {
        if (fgets(idx, sizeof(idx), f)) {
          idx[strcspn(idx, "\r\n")] = '\0';
        }
        pclose(f);
      }
    }
#endif
    snprintf(text, sizeof(text), "{\"Version\":\"%s (%s)\"}", webserver_version, idx);
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
    char _cdesc[128];
    const char *_c = client_desc_from_request(req, _cdesc, sizeof(_cdesc));
    fprintf(stderr, "%s: HTTP request (no websocket upgrade) from %s - serving redirect\n", __FUNCTION__, _c);
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

  /* Enforce server-wide concurrent websocket limit. If at capacity,
     attach a short-lived reject callback that sends a BUSY message. */
  pthread_mutex_lock(&session_mutex);
  if (nsessions >= MAX_SESSIONS) {
    pthread_mutex_unlock(&session_mutex);
    fprintf(stderr, "home: rejecting websocket — max clients %d reached\n", MAX_SESSIONS);
    onion_websocket_set_callback(ws, reject_ws_cb);
    return OCS_WEBSOCKET;
  }
  pthread_mutex_unlock(&session_mutex);

  // create session (or attempt to reattach to an existing one for this client)
  char client_desc_buf[128];
  const char *client_desc = client_desc_from_request(req, client_desc_buf, sizeof(client_desc_buf));
  // Try to find an existing session with the same client description and attach to it.
  pthread_mutex_lock(&session_mutex);
  struct session *existing = sessions;
  while (existing != NULL) {
    if (client_desc && strcmp(existing->client, client_desc) == 0) {
      /* Only reattach if the previous websocket is gone. This prevents a
         new websocket from the same IP/host (e.g. a second browser tab)
         from clobbering an active session and stealing its SSRC. */
      if (existing->ws != NULL) {
        /* Active session already present for this client description; skip reattach. */
        existing = existing->next;
        continue;
      }
      /* Reattach websocket to existing session to preserve SSRC and state */
      existing->ws = ws;
      /* Attempt to set underlying websocket socket non-blocking so writes
         return EAGAIN instead of blocking the server. This uses the
         request-level fd exposed by libonion (if available). */
      do {
        int wsfd = -1;
        /* Many libonion builds expose an accessor `onion_request_get_fd`.
           Try to retrieve the fd and set O_NONBLOCK. If the symbol is not
           available in the libonion version used to build, this call will
           generate a link error at build time and should be adjusted to
           the appropriate accessor for that version. */
        wsfd = get_request_fd(req);
        if (wsfd >= 0) {
          int flags = fcntl(wsfd, F_GETFL, 0);
          if (flags != -1) {
            if (!(flags & O_NONBLOCK)) {
              if (fcntl(wsfd, F_SETFL, flags | O_NONBLOCK) == -1) {
                perror("fcntl F_SETFL O_NONBLOCK (websocket reattach)");
              } else if (debug_send) {
                fprintf(stderr, "home: set websocket fd %d non-blocking (reattach) for ws=%p\n", wsfd, (void *)ws);
              }
            }
          } else {
            perror("fcntl F_GETFL (websocket reattach)");
          }
          /* record fd on reattach so writer thread can poll it */
          existing->ws_fd = wsfd;
        }
      } while(0);
      pthread_mutex_unlock(&session_mutex);
      /* Mark this session as having a recent client interaction so the
        server will not immediately adopt backend-reported presets on
        reconnect. This prevents unwanted mode switches when clients
        briefly disconnect and reconnect. */
      existing->last_client_command_ms = now_ms();
      /* Also record explicit reattach time so adoption logic can treat
         recent reattaches as recent client activity even if other
         timestamps are stale. */
      existing->reattach_time_ms = now_ms();
      fprintf(stderr, "%s: reattaching websocket ws=%p to existing SSRC=%u client=%s\n", __FUNCTION__, (void *)ws, existing->ssrc, existing->client);
      onion_websocket_set_callback(ws, websocket_cb);
      return OCS_WEBSOCKET;
    }
    existing = existing->next;
  }
  pthread_mutex_unlock(&session_mutex);

  int i;
  struct session *sp=calloc(1,sizeof(*sp));
  /*
   * SSRC allocation convention:
   *  - Each logical client session is assigned a pair of SSRCs by the backend.
   *    The even SSRC (sp->ssrc) identifies the audio/status stream and
   *    the odd SSRC (sp->ssrc + 1) identifies the spectrum stream. Clients
   *    must receive spectrum RTP packets with SSRC == sp->ssrc + 1 so the
   *    browser can correctly associate spectrum frames when multiple
   *    sessions/clients are active.
   */
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
  /* Try to set the underlying websocket socket to non-blocking so slow
     clients do not block server threads. As with the reattach path above,
     this attempts to use `onion_request_get_fd(req)` if available in the
     libonion build used. */
  do {
    int wsfd = -1;
    wsfd = get_request_fd(req);
    if (wsfd >= 0) {
      int flags = fcntl(wsfd, F_GETFL, 0);
      if (flags != -1) {
        if (!(flags & O_NONBLOCK)) {
          if (fcntl(wsfd, F_SETFL, flags | O_NONBLOCK) == -1) {
            perror("fcntl F_SETFL O_NONBLOCK (websocket)");
          } else if (debug_send) {
            fprintf(stderr, "home: set websocket fd %d non-blocking for ws=%p\n", wsfd, (void *)ws);
          }
        }
      } else {
        perror("fcntl F_GETFL (websocket)");
      }
    } else if (debug_send) {
      /* Suppressed noisy debug: some libonion builds do not expose the
         underlying request FD via `onion_request_get_fd()`. The server
         already handles ws_fd == -1 by falling back to direct writes
         and the watchdog will clean stuck sessions, so this per-connection
         diagnostic is commented out to reduce log noise during testing. */
      /* fprintf(stderr, "home: unable to obtain websocket fd to set non-blocking for ws=%p\\n", (void *)ws); */
    }
    /* Record underlying fd (or -1 if not available) for use by writer thread */
    sp->ws_fd = wsfd;
  } while(0);
  fprintf(stderr, "%s: new websocket ws=%p assigned SSRC=%u client=%s\n", __FUNCTION__, (void *)ws, sp->ssrc, sp->client);
  sp->spectrum_active=true;
  sp->audio_active=false;
  /* adoptOnParameterMismatch removed; adoption controlled server-side by backend shift */


  sp->frequency=10000000;
  int level = 0;
#if 0
  sp->center_frequency = Frontend.samprate/4;
  const int table_size = sizeof(zoom_table) / sizeof(zoom_table[0]);


  for(; level < table_size; level++)
    if(zoom_table[level].bin_width * zoom_table[level].bin_count <= Frontend.samprate/2)
      break;
  sp->zoom_index = level;
#else
  level = 6;
#endif
  sp->bins=zoom_table[level].bin_count;
  sp->bin_width=zoom_table[level].bin_width; // width of a pixel in hz
  sp->next=NULL;
  sp->previous=NULL;
  sp->shift = NAN;

  sp->bins_min_db = -120;
  sp->bins_max_db = 0;
  /* Preserve requested_preset from any existing session with the same
     client description if present. This helps a reconnecting client keep
     its previously-selected mode instead of reverting to the backend's
     default (commonly AM). */
  strlcpy(sp->requested_preset, "am", sizeof(sp->requested_preset));
  if (client_desc) {
    pthread_mutex_lock(&session_mutex);
    struct session *prev = sessions;
    while (prev != NULL) {
      if (prev != sp && prev->client[0] != '\0' && strcmp(prev->client, client_desc) == 0) {
        /* Found another session for this client; copy its requested preset */
        if (prev->requested_preset[0] != '\0') {
          strlcpy(sp->requested_preset, prev->requested_preset, sizeof(sp->requested_preset));
          if (debug_send) fprintf(stderr, "%s: preserving requested_preset '%s' from existing session ssrc=%u for client=%s\n", __FUNCTION__, sp->requested_preset, prev->ssrc, client_desc);
        }
        break;
      }
      prev = prev->next;
    }
    pthread_mutex_unlock(&session_mutex);
  }
  if (client_desc)
    strlcpy(sp->client, client_desc, sizeof(sp->client));
  pthread_mutex_init(&sp->ws_mutex,NULL);
  pthread_mutex_init(&sp->spectrum_mutex,NULL);
  /* initialize per-session poll interval from global default */
  sp->spectrum_poll_us = spectrum_poll_us;
  add_session(sp);
  init_control(sp);
  //fprintf(stderr,"%s: onion_websocket_set_callback: websocket_cb\n",__FUNCTION__);
  onion_websocket_set_callback(ws, websocket_cb);

  /* monitor start removed */

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

  /* Wait for dest socket to be ready, then try to open/maintain Input_fd
     The monitor thread may close Input_fd to force a reopen; loop so we
     recover automatically. */
  for (;;) {
    pthread_mutex_lock(&output_dest_socket_mutex);
    while (Channel.output.dest_socket.sa_family == 0)
      pthread_cond_wait(&output_dest_socket_cond, &output_dest_socket_mutex);
    /* Attempt to open if not already open */
    if (Input_fd == -1) {
      Input_fd = listen_mcast(NULL, &Channel.output.dest_socket, NULL);
      if (Input_fd != -1) {
        /* Increase receive buffer to 256 KiB to reduce packet drops during
           brief bursts of multicast traffic; also set a 1s recv timeout so
           the thread can periodically check shutdown conditions. */
        int rcv = 256 * 1024; /* 256 KiB */
        if (setsockopt(Input_fd, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof(rcv)) < 0) {
          perror("setsockopt SO_RCVBUF Input_fd");
        }
        struct timeval tv;
        tv.tv_sec = 1; tv.tv_usec = 0;
        if (setsockopt(Input_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) < 0) {
          perror("setsockopt SO_RCVTIMEO Input_fd");
        }
      }
    }
    pthread_mutex_unlock(&output_dest_socket_mutex);

    if (Input_fd == -1) {
      /* Couldn't open yet; wait then retry */
      usleep(500000);
      continue;
    }
    break;
  }

  while (1) {
    int fd;
    /* Snapshot Input_fd under the mutex to avoid races with monitor close */
    pthread_mutex_lock(&output_dest_socket_mutex);
    fd = Input_fd;
    pthread_mutex_unlock(&output_dest_socket_mutex);

    if (fd == -1) {
      /* No input socket right now; back off and retry */
      usleep(1000);
      continue;
    }

    struct sockaddr_storage sender;
    socklen_t socksize = sizeof(sender);
    ssize_t size = recvfrom(fd, &pkt->content, sizeof(pkt->content), 0,
                            (struct sockaddr *)&sender, &socksize);

    if (size == -1) {
      if (errno == EINTR)
        continue; /* interrupted, try again */
      if (errno == EAGAIN || errno == EWOULDBLOCK)
        continue; /* no data available yet, not an error to log */
      if (errno == EBADF) {
        /* Socket was closed by monitor thread after we snapped it; back off */
        usleep(1000);
        continue;
      }
      /* Unexpected error; log it once and back off briefly */
      perror("recvfrom");
      fprintf(stderr, "address=%s\n", formatsock(&Channel.output.dest_socket, false));
      usleep(1000);
      continue; /* reuse current buffer */
    }

    if (size <= RTP_MIN_SIZE)
      continue; /* Must be big enough for RTP header and at least some data */

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

    /* record last successful audio packet recv for watchdog */
    last_audio_recv_ms = now_ms();
    if (debugSSRC) fprintf(stderr, "monitor: audio recv ssrc=%u at %lu\n", pkt->rtp.ssrc, last_audio_recv_ms);


    sp = find_session_from_ssrc(pkt->rtp.ssrc);
//fprintf(stderr,"%s: sp=%p ssrc=%d\n",__FUNCTION__,sp,pkt->rtp.ssrc);
    if (sp != NULL) {
      if (sp->ws == NULL) {
        if (debugSSRC) fprintf(stderr, "%s: removing stale audio session ssrc=%d sp=%p\n", __FUNCTION__, sp->ssrc, (void *)sp);
        delete_session(sp);
        continue;
      }
      if (sp->audio_active) {
        send_ws_binary_to_session(sp, (uint8_t *)pkt->content, size);
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
  time_t start = time(NULL);

  /* Retry resolving and listening for multicast status until successful or timeout.
     This allows the backend (ka9q-radio) to come up after the web server. */
  for (;;) {
    resolve_mcast(multicast_group, &Metadata_dest_socket, DEFAULT_STAT_PORT,
                  iface, sizeof(iface), 0);
    Status_fd = listen_mcast(NULL, &Metadata_dest_socket, iface);
    if (Status_fd != -1)
      break;
    if (ConnTimeoutSeconds > 0 && (int)(time(NULL) - start) >= ConnTimeoutSeconds) {
      fprintf(stderr, "Timed out (%ds) trying to listen to mcast status %s\n", ConnTimeoutSeconds, multicast_group);
      return EX_IOERR;
    }
    fprintf(stderr, "Can't listen to mcast status %s - retrying in 2s\n", multicast_group);
    sleep(2);
  }

  /* Increase receive buffer and set a recv timeout to avoid blocking indefinitely */
      {
    /* Increase kernel socket receive buffer to 256 KiB to reduce UDP
       packet loss for short bursts. This is a kernel hint and may be
       adjusted by the OS; it helps when the process cannot keep up with
       incoming packets briefly. Also set a 1s recv timeout to avoid
       blocking indefinitely. */
    int rcv = 256 * 1024; /* 256 KiB receive buffer */
    if (setsockopt(Status_fd, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof(rcv)) < 0) {
      perror("setsockopt SO_RCVBUF Status_fd");
    }
    struct timeval tv;
    tv.tv_sec = 1; tv.tv_usec = 0; /* 1 second timeout */
    if (setsockopt(Status_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) < 0) {
      perror("setsockopt SO_RCVTIMEO Status_fd");
    }
  }

  /* Retry connecting control socket until successful or timeout. */
  for (;;) {
    Ctl_fd = connect_mcast(&Metadata_dest_socket, iface, Mcast_ttl, IP_tos);
    if (Ctl_fd >= 0)
      break;
    if (ConnTimeoutSeconds > 0 && (int)(time(NULL) - start) >= ConnTimeoutSeconds) {
      fprintf(stderr, "Timed out (%ds) trying to connect control mcast\n", ConnTimeoutSeconds);
      return EX_IOERR;
    }
    fprintf(stderr, "connect to mcast control failed - retrying in 2s\n");
    sleep(2);
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
  /* monitor thread will be started on first client connect to avoid startup noise */
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

  encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // Specific SSRC
  encode_double(&bp,RADIO_FREQUENCY,10000000);
  sent_tag = arc4random();
  encode_int(&bp,COMMAND_TAG,sent_tag); // Append a command tag
  encode_string(&bp,PRESET,"am",strlen("am"));
  encode_eol(&bp);
  int command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
    fprintf(stderr,"command send error: %s\n",strerror(errno));
  } else {
    usleep(CONTROL_USLEEP_US);
  }
  pthread_mutex_unlock(&ctl_mutex);

  bp = cmdbuffer;
  *bp++ = CMD; // Command

  encode_int(&bp,OUTPUT_SSRC,sp->ssrc+1); // Specific SSRC
  encode_double(&bp,RADIO_FREQUENCY,10000000);
  sent_tag = arc4random();
  encode_int(&bp,COMMAND_TAG,sent_tag); // Append a command tag
  encode_eol(&bp);
  command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
    fprintf(stderr,"command send error: %s\n",strerror(errno));
  } else {
    usleep(CONTROL_USLEEP_US);
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
    /* Round to nearest Hz when storing in integer session field */
    sp->frequency = (uint32_t)lround(f);
    encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // Specific SSRC
    encode_int(&bp,COMMAND_TAG,arc4random()); // Append a command tag
    encode_double(&bp,RADIO_FREQUENCY,f);
    encode_eol(&bp);
    int const command_len = bp - cmdbuffer;
    pthread_mutex_lock(&ctl_mutex);
    if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
      fprintf(stderr,"command send error: %s\n",strerror(errno));
    } else {
      unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
      if (verbose && debug_send) fprintf(stderr, "%s: +%lums: sending RADIO_FREQUENCY=%.0f Hz for ssrc=%u\n", __FUNCTION__, elapsed_ms, f, (unsigned)sp->ssrc);
      /* allow backend a short time to process this command before sending another */
      usleep(CONTROL_USLEEP_US/2);
      //if (verbose && debug_send) fprintf(stderr, "%s: +%lums: send OK\n", __FUNCTION__, elapsed_ms);
    }
    pthread_mutex_unlock(&ctl_mutex);
  }
}

/*
  control_set_shift
  -----------------
  Send a `SHIFT_FREQUENCY` command to the backend for the given session.

  - `str` is parsed as a floating-point shift in Hz.
  - Command format mirrors other control setters: `{ CMD, OUTPUT_SSRC, COMMAND_TAG, SHIFT_FREQUENCY, EOL }`.
  - Uses `ctl_mutex` to protect `Ctl_fd` and sleeps `CONTROL_USLEEP_US` after a successful send.
  - Note: the session's `sp->shift` is updated by incoming status packets; this function
    does not modify `sp->shift` so the backend remains the authoritative source.
*/
void control_set_shift(struct session *sp,char *str) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  double s;

  if(strlen(str) > 0){
    *bp++ = CMD; // Command
    s = strtod(str, NULL); // shift in Hz
    encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // Specific SSRC
    encode_int(&bp,COMMAND_TAG,arc4random()); // Append a command tag
    encode_double(&bp,SHIFT_FREQUENCY,s);
    encode_eol(&bp);
    int const command_len = bp - cmdbuffer;
    pthread_mutex_lock(&ctl_mutex);
    if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
      fprintf(stderr,"command send error: %s\n",strerror(errno));
    } else {
      usleep(CONTROL_USLEEP_US);
    }
    pthread_mutex_unlock(&ctl_mutex);
  }
}

/* Send filter edge settings (low and high) to the control socket for this session.
   low_str and high_str are strings containing values in Hz (or kHz?) - follow same units as client.
*/
void control_set_filter_edges(struct session *sp, char *low_str, char *high_str) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  float lowf = 0.0f;
  float highf = 0.0f;

  if (low_str && strlen(low_str) > 0)
    lowf = strtof(low_str, NULL);
  if (high_str && strlen(high_str) > 0)
    highf = strtof(high_str, NULL);

  *bp++ = CMD; // Command
  encode_int(&bp, OUTPUT_SSRC, sp->ssrc);
  encode_int(&bp, COMMAND_TAG, arc4random());
  /* Encode LOW_EDGE then HIGH_EDGE as floats */
  encode_float(&bp, LOW_EDGE, lowf);
  encode_float(&bp, HIGH_EDGE, highf);
  encode_eol(&bp);

  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if (verbose && debug_send) {
    unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
    fprintf(stderr, "%s: +%lums: sending filter edges low=%f high=%f\n", __FUNCTION__, elapsed_ms, lowf, highf);
  }
    if (send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    fprintf(stderr, "%s: command send error: %s\n", __FUNCTION__, strerror(errno));
  } else {
    //if (verbose) fprintf(stderr, "%s: send OK\n", __FUNCTION__);
    usleep(CONTROL_USLEEP_US);
  }
  pthread_mutex_unlock(&ctl_mutex);
}

/* Send spectrum averaging value (integer) to control socket for this session */
void control_set_spectrum_average(struct session *sp, char *val_str) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  int val = 0;

  if (val_str && strlen(val_str) > 0)
    val = atoi(val_str);
  if (val_str && strlen(val_str) > 0)
    val = atoi(val_str);

  int target_ssrc = sp ? (sp->ssrc + 1) : 0; /* use ssrc+1 for spectrum stream */
  /* fprintf(stderr, "%s: control_set_spectrum_average called sp=%p ssrc=%d target_ssrc=%d val=%d\n", __FUNCTION__, sp, sp?sp->ssrc:0, target_ssrc, val); */
  /* fflush(stderr); */

  *bp++ = CMD; // Command
  /* Include SSRC for which this setting applies - target the spectrum stream (ssrc+1) */
  /* Use fixed 32-bit encodings to keep command packet length deterministic */
  encode_int32(&bp, OUTPUT_SSRC, (uint32_t)target_ssrc);
  encode_int32(&bp, COMMAND_TAG, (uint32_t)arc4random());
  /* Encode spectrum average as integer SPECTRUM_AVG */
  encode_int(&bp, SPECTRUM_AVG, val);
  encode_eol(&bp);

  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if (send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    fprintf(stderr, "command send error: %s\n", strerror(errno));
  } else {
    /* fprintf(stderr, "%s: sent SPECTRUM_AVG=%d (len=%d) to control fd=%d\n", __FUNCTION__, val, command_len, Ctl_fd); */
    /* fflush(stderr); */
    usleep(CONTROL_USLEEP_US);
  }
  pthread_mutex_unlock(&ctl_mutex);
}

/* Send spectrum FFT overlap (float 0 <= x < 1) to control socket for this session */
void control_set_spectrum_overlap(struct session *sp, char *val_str) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  float val = 0.0f;

  if (val_str && strlen(val_str) > 0)
    val = strtof(val_str, NULL);

  int target_ssrc = sp ? (sp->ssrc + 1) : 0; /* use ssrc+1 for spectrum stream */

  *bp++ = CMD; // Command
  /* Include SSRC for which this setting applies - target the spectrum stream (ssrc+1) */
  encode_int(&bp, OUTPUT_SSRC, target_ssrc);
  encode_int(&bp, COMMAND_TAG, arc4random());
  /* Encode spectrum overlap as float SPECTRUM_OVERLAP */
  encode_float(&bp, SPECTRUM_OVERLAP, val);
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if (verbose && debug_send) {
    unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
    fprintf(stderr, "%s: +%lums: sending SPECTRUM_OVERLAP=%f\n", __FUNCTION__, elapsed_ms, (double)val);
  }
  if (send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    fprintf(stderr, "%s: command send error: %s\n", __FUNCTION__, strerror(errno));
  } else {
    //if (verbose) fprintf(stderr, "%s: send OK\n", __FUNCTION__);
    usleep(CONTROL_USLEEP_US);
  }
  pthread_mutex_unlock(&ctl_mutex);
}

/* Send window type (UINT) to control socket for this session and save spectrum shape locally
   type_str expected to be names like "KAISER_WINDOW", "GAUSSIAN_WINDOW", etc. */
void control_set_window_type(struct session *sp, char *type_str, char *shape_str) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  int val = 0; /* default to KAISER_WINDOW */

  if (type_str && strlen(type_str) > 0) {
    if (strcmp(type_str, "KAISER_WINDOW") == 0) val = 0;
    else if (strcmp(type_str, "RECT_WINDOW") == 0) val = 1;
    else if (strcmp(type_str, "BLACKMAN_WINDOW") == 0) val = 2;
    else if (strcmp(type_str, "EXACT_BLACKMAN_WINDOW") == 0) val = 3;
    else if (strcmp(type_str, "GAUSSIAN_WINDOW") == 0) val = 4;
    else if (strcmp(type_str, "HANN_WINDOW") == 0) val = 5;
    else if (strcmp(type_str, "HAMMING_WINDOW") == 0) val = 6;
    else if (strcmp(type_str, "BLACKMAN_HARRIS_WINDOW") == 0) val = 7;
    else if (strcmp(type_str, "HP5FT_WINDOW") == 0) val = 8;
    else val = 0;
  }
  int target_ssrc = sp ? (sp->ssrc + 1) : 0; /* target spectrum stream (ssrc+1) */
  *bp++ = CMD; // Command
  /* Include SSRC for which this setting applies - target the spectrum stream (ssrc+1) */
  encode_int(&bp, OUTPUT_SSRC, target_ssrc);
  encode_int(&bp, COMMAND_TAG, arc4random());
  /* Encode window type as integer using tag WINDOW_TYPE (status.h) */
  encode_int(&bp, WINDOW_TYPE, val);
  if (sp && shape_str){
    double shape = strtod(shape_str,NULL);
    encode_float(&bp,SPECTRUM_SHAPE,shape);
  }
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if (send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    fprintf(stderr, "command send error: %s\n", strerror(errno));
  } else {
    usleep(CONTROL_USLEEP_US);
  }
  pthread_mutex_unlock(&ctl_mutex);
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
    encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // Specific SSRC
    encode_int(&bp,COMMAND_TAG,arc4random()); // Append a command tag
    encode_string(&bp,PRESET,str,strlen(str));
    encode_eol(&bp);
    int const command_len = bp - cmdbuffer;
    pthread_mutex_lock(&ctl_mutex);
    strlcpy(sp->requested_preset,str,sizeof(sp->requested_preset));
    if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len){
      fprintf(stderr,"command send error: %s\n",strerror(errno));
    } else {
      unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
      if (verbose && debug_send) fprintf(stderr, "%s: +%lums: sending PRESET='%s' for ssrc=%u\n", __FUNCTION__, elapsed_ms, str, (unsigned)sp->ssrc);
      usleep(CONTROL_USLEEP_US);
      //if (verbose && debug_send) fprintf(stderr, "%s: +%lums: send OK\n", __FUNCTION__, elapsed_ms);
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
void control_set_encoding(struct session *sp, bool use_opus) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  *bp++ = CMD;
  encode_int(&bp, OUTPUT_SSRC, sp->ssrc);
  encode_int(&bp, COMMAND_TAG, arc4random());
  encode_int(&bp, OUTPUT_ENCODING, use_opus ? OPUS : S16BE);
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    fprintf(stderr, "command send error: %s\n", strerror(errno));
  } else {
    if (verbose)
      fprintf(stderr, "%s: set encoding to %s for ssrc=%u\n", __FUNCTION__,
              use_opus ? "OPUS" : "PCM", (unsigned)sp->ssrc);
    usleep(CONTROL_USLEEP_US);
  }
  pthread_mutex_unlock(&ctl_mutex);
}

void stop_spectrum_stream(struct session *sp) {
  uint8_t cmdbuffer[PKTSIZE];
  uint8_t *bp = cmdbuffer;
  *bp++ = CMD; // Command
  encode_int(&bp,OUTPUT_SSRC,sp->ssrc+1);
  uint32_t tag = random();
  encode_int(&bp,COMMAND_TAG,tag);
  encode_int(&bp,DEMOD_TYPE,SPECT2_DEMOD);
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
    usleep(spectrum_poll_us);
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
  encode_int(&bp,DEMOD_TYPE,SPECT2_DEMOD);
  encode_double(&bp,RADIO_FREQUENCY,frequency);
  encode_int(&bp,BIN_COUNT,bins);
  encode_float(&bp,RESOLUTION_BW,bin_bw);
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    perror("command send: Spectrum");
  } else {
    usleep(CONTROL_USLEEP_US);
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
  static int poll_count = 0;
  uint8_t cmdbuffer[128];
  uint8_t *bp = cmdbuffer;
  *bp++ = 1; // Command

  /* sp->last_poll_tag = random(); */
  encode_int(&bp,OUTPUT_SSRC,sp->ssrc); // poll specific SSRC, or request ssrc list with ssrc = 0
  encode_int(&bp,COMMAND_TAG,random());
  /* encode_int(&bp,COMMAND_TAG,sp->last_poll_tag); */
  encode_eol(&bp);
  int const command_len = bp - cmdbuffer;
  pthread_mutex_lock(&ctl_mutex);
  if(send(Ctl_fd, cmdbuffer, command_len, 0) != command_len) {
    perror("command send: Poll");
  } else {
    if (++poll_count >= 100) {
      poll_count = 0;
      poll_start_ms = now_ms();
    } else if (poll_count == 1 && poll_start_ms == 0) {
      /* first poll ever: start the timer */
      poll_start_ms = now_ms();
    }
    unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
    if (verbose && debug_send && debug_send_poll) fprintf(stderr, "%s: +%lums: sending poll #%d for ssrc=%u\n", __FUNCTION__, elapsed_ms, poll_count, (unsigned)sp->ssrc);
    usleep(CONTROL_USLEEP_US);
    if (verbose && debug_send && debug_send_poll) fprintf(stderr, "%s: +%lums: send OK (poll #%d)\n", __FUNCTION__, elapsed_ms, poll_count);
  }
  pthread_mutex_unlock(&ctl_mutex);
}

/* Forward declarations for helpers used by extract_powers (definitions follow below) */
static int handle_bin_byte_data(float *power, int npower, uint8_t const *cp, unsigned int optlen);
static int handle_bin_data(float *power, int npower, uint8_t const *cp, unsigned int optlen, struct session *sp);

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
  int64_t N = (Frontend.L + Frontend.M - 1);
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
        if(i != SPECT_DEMOD && i != SPECT2_DEMOD)
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
    case BIN_BYTE_DATA:
      l_count = optlen / sizeof(uint8_t);
      if(l_count > npower)
        return -2; // Not enough room in caller's array
      if (0 == N)
        break;
      if (handle_bin_byte_data(power, npower, cp, optlen) < 0)
        return -2;
      /* record per-session spectrum receive time */
      if (sp)
        sp->last_spectrum_recv_ms = now_ms();
      break;
    case BIN_DATA:
      l_count = optlen/sizeof(float);
      if(l_count > npower)
        return -2; // Not enough room in caller's array
      if (0 == N)
        break;
      if (handle_bin_data(power, npower, cp, optlen, sp) < 0)
        return -2;
      /* record per-session spectrum receive time */
      if (sp)
        sp->last_spectrum_recv_ms = now_ms();
      break;
    case RESOLUTION_BW:
      *bin_bw = decode_float(cp,optlen);
      break;
    case IF_POWER:
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
    return -1;
  }

  if (l_count > MAX_BINS) {
    return -1;
  }
  return l_ccount;
}

/* --- Helpers for extract_powers --- */
static int handle_bin_byte_data(float *power, int npower, uint8_t const *cp, unsigned int optlen)
{
  int l_count = optlen / sizeof(uint8_t);
  if (l_count > npower)
    return -1;
  if (l_count == 0)
    return 0;
  for (int i = 0; i < l_count; i++) {
    uint8_t j = decode_int8(cp, sizeof(uint8_t));
    power[i] = j;
    cp += sizeof(uint8_t);
  }
  return 0;
}

static int handle_bin_data(float *power, int npower, uint8_t const *cp, unsigned int optlen, struct session *sp)
{
  int l_count = optlen / sizeof(float);
  if (l_count > npower)
    return -1;
  if (l_count == 0)
    return 0;
  sp->bins_max_db = -INFINITY;
  sp->bins_min_db = +INFINITY;
  int i = l_count / 2; // DC
  do {
    float p = decode_float(cp, sizeof(float));
    p = power2dB(p);
    if (p == -INFINITY)
      p = -150;
    power[i] = p;
    if (p > sp->bins_max_db)
      sp->bins_max_db = p;
    if (p < sp->bins_min_db)
      sp->bins_min_db = p;
    cp += sizeof(float);
    i++;
    if (i == l_count)
      i = 0;
  } while (i != l_count / 2);
  return 0;
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
  while(sp->spectrum_active) {
    pthread_mutex_lock(&sp->spectrum_mutex);
    control_get_powers(sp,(float)sp->center_frequency,sp->bins,(float)sp->bin_width);
    pthread_mutex_unlock(&sp->spectrum_mutex);
    control_poll(sp);
    if(usleep(sp->spectrum_poll_us) != 0) {
      perror("spectrum_thread: usleep(sp->spectrum_poll_us)");
    }
  }
  return NULL;
}

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

/* Forward declarations for helpers used by ctrl_thread (helpers defined later) */
static ssize_t recv_status_packet(uint8_t *buffer, size_t buflen, uint32_t *out_ssrc);
static void process_spectrum_packet(struct session *sp, uint8_t *buffer, int rx_length);
static void process_status_packet(struct session *sp, uint8_t *buffer, int rx_length, double *last_sent_backend_frequency);
static bool tlv_has_type(uint8_t const *buf, int len, enum status_type want);

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
power values from the received packet (via `extract_powers()` and its helpers), packages the decoded power
values into the output buffer, and sends the binary payload to the client’s WebSocket.

Note: `extract_powers()` and `handle_bin_data()` compute per-session min/max dB (stored in
`sp->bins_min_db` / `sp->bins_max_db`) while decoding, but `process_spectrum_packet()` does not apply any
automatic rescaling/autoranging to the outgoing 8-bit payload in this implementation.

If the SSRC indicates regular status data (even value), the function updates the session’s status, extracts noise density,
and checks if the current preset and frequency match the requested values. If not, it issues commands to correct them.
It also prepares and sends a status RTP packet to the client, including baseband power and filter edge information,
and optionally a description string.

Throughout the function, mutexes are used to ensure thread-safe access to shared resources, such as session data
and WebSocket connections. The code is robust, handling errors gracefully and providing debug output when necessary.
This design allows the application to efficiently process and forward real-time radio or spectrum data to
multiple clients, supporting features like dynamic scaling, error correction, and session management.
*/
void *ctrl_thread(void *arg)
{
  static double last_sent_backend_frequency = 0.0;
  uint8_t buffer[PKTSIZE / sizeof(float)];

  if (run_with_realtime)
    set_realtime();

  while (1) {
    uint32_t ssrc = 0;
    ssize_t rx_length = recv_status_packet(buffer, sizeof(buffer), &ssrc);
    if (rx_length <= 2)
      continue;
    if (debugSSRC)
      fprintf(stderr, "ctrl_thread: recv_status_packet len=%zd ssrc=%u\n", rx_length, ssrc);

    if (ssrc % 2 == 1) { /* spectrum */
      struct session *sp = find_session_from_ssrc(ssrc - 1);
      if (sp) {
        if (sp->ws == NULL) {
          /* Stale session: no websocket associated. Remove it so a reconnect
             can take its SSRC slot. `delete_session` unlocks the session_mutex. */
          if (debugSSRC) fprintf(stderr, "ctrl_thread: removing stale spectrum session ssrc=%u sp=%p\n", sp->ssrc, (void *)sp);
          delete_session(sp);
        } else {
          if (debugSSRC)
            fprintf(stderr, "ctrl_thread: spectrum packet ssrc=%u -> session ssrc=%u sp=%p\n", ssrc, sp->ssrc, (void *)sp);
          process_spectrum_packet(sp, buffer, (int)rx_length);
          pthread_mutex_unlock(&session_mutex);
        }
      } else {
        if (debugSSRC)
          fprintf(stderr, "ctrl_thread: spectrum packet ssrc=%u -> no session found for lookup ssrc=%u\n", ssrc, ssrc - 1);
      }
    } else { /* regular status */
      struct session *sp = find_session_from_ssrc(ssrc);
      if (sp) {
        if (sp->ws == NULL) {
          if (debugSSRC) fprintf(stderr, "ctrl_thread: removing stale status session ssrc=%u sp=%p\n", sp->ssrc, (void *)sp);
          delete_session(sp);
        } else {
          if (debugSSRC)
            fprintf(stderr, "ctrl_thread: status packet ssrc=%u -> session ssrc=%u sp=%p\n", ssrc, sp->ssrc, (void *)sp);
          process_status_packet(sp, buffer, (int)rx_length, &last_sent_backend_frequency);
          pthread_mutex_unlock(&session_mutex);
        }
      } else {
        if (debugSSRC)
          fprintf(stderr, "ctrl_thread: status packet ssrc=%u -> no session found\n", ssrc);
      }
    }
  }
  return NULL;
}

/* Helper: receive a status packet and extract ssrc (keeps simple recvfrom handling centralized) */
static ssize_t recv_status_packet(uint8_t *buffer, size_t buflen, uint32_t *out_ssrc)
{
  socklen_t ssize = sizeof(Metadata_source_socket);
  /* Snapshot Status_fd to avoid a null/closed fd obvious cases; callers
     should handle non-positive returns. If Status_fd is -1 return -1 so
     callers know there's no active socket. */
  if (Status_fd == -1)
    return -1;
  ssize_t rx_length = recvfrom(Status_fd, buffer, buflen, 0,
                               (struct sockaddr *)&Metadata_source_socket, &ssize);
  if (rx_length <= 0) {
    if (rx_length == -1) {
      if (errno == EINTR)
        return -1;
      if (errno == EAGAIN || errno == EWOULDBLOCK)
        return -1;
      if (errno == EBADF) {
        /* Socket was closed by monitor thread; return so caller can continue */
        return -1;
      }
      /* Unexpected recv error: log and return */
      perror("recvfrom(status)");
      return -1;
    }
    return rx_length;
  }
  /* Record last successful status receive time (monotonic ms) */
  last_status_recv_ms = now_ms();
  if (rx_length > 2 && (enum pkt_type)buffer[0] == STATUS) {
    *out_ssrc = get_ssrc(buffer + 1, rx_length - 1);
  } else {
    *out_ssrc = 0;
  }
  if (debugSSRC && *out_ssrc)
    fprintf(stderr, "monitor: status recv ssrc=%u at %lu\n", *out_ssrc, last_status_recv_ms);
  return rx_length;
}

/*
  send_ws_binary_to_session
  --------------------------
  Thread-safe helper to send a binary payload over a session's websocket to the web browser client.

  - Recipient: the web browser client connected on `sp->ws`.
  - Locks `sp->ws_mutex` to serialize websocket access for the session.
  - Sets the websocket opcode to binary and writes `size` bytes from `buf`.
  - Logs an error to stderr when the write fails (return value <= 0).
  - Always unlocks `sp->ws_mutex` before returning.
*/
static void send_ws_binary_to_session(struct session *sp, uint8_t *buf, int size)
{
  /* Enqueue binary payload for the per-session writer thread. */
  if (sp == NULL) return;
  if (size <= 0 || buf == NULL) return;
  enqueue_ws_message(sp, buf, size, 0);
}

/*
  send_ws_text_to_session
  ------------------------
  Thread-safe helper to send a text (UTF-8) message over a session's websocket to the web browser client.

  - Recipient: the web browser client connected on `sp->ws`.
  - Locks `sp->ws_mutex` to serialize websocket access for the session.
  - Sets the websocket opcode to text and writes the NUL-terminated `msg`.
  - Does not perform retries; failures are not explicitly reported here.
  - Always unlocks `sp->ws_mutex` before returning.
*/
static void send_ws_text_to_session(struct session *sp, const char *msg)
{
  if (sp == NULL || msg == NULL) return;
  enqueue_ws_message(sp, (const uint8_t *)msg, (int)strlen(msg), 1);
}

/* Enqueue a message onto the session outgoing queue. Caller may be any thread. */
static void enqueue_ws_message(struct session *sp, const uint8_t *buf, int size, int is_text)
{
  struct ws_msg *m = calloc(1, sizeof(*m));
  if (!m) return;
  m->data = malloc(size);
  if (!m->data) { free(m); return; }
  memcpy(m->data, buf, size);
  m->size = size;
  m->is_text = is_text;
  m->next = NULL;

  pthread_mutex_lock(&sp->out_mutex);
  if (sp->out_tail == NULL) {
    sp->out_head = sp->out_tail = m;
  } else {
    sp->out_tail->next = m;
    sp->out_tail = m;
  }
  pthread_cond_signal(&sp->out_cond);
  pthread_mutex_unlock(&sp->out_mutex);
}

/* Free any queued outgoing messages (caller must ensure writer not running). */
static void free_out_queue(struct session *sp)
{
  pthread_mutex_lock(&sp->out_mutex);
  struct ws_msg *m = sp->out_head;
  sp->out_head = sp->out_tail = NULL;
  pthread_mutex_unlock(&sp->out_mutex);
  while (m) {
    struct ws_msg *n = m->next;
    if (m->data) free(m->data);
    free(m);
    m = n;
  }
}

/* Writer thread: pop messages and perform websocket writes. */
static void *session_writer_thread(void *arg)
{
  struct session *sp = (struct session *)arg;
  while (1) {
    pthread_mutex_lock(&sp->out_mutex);
    while (sp->out_head == NULL && sp->writer_running) {
      pthread_cond_wait(&sp->out_cond, &sp->out_mutex);
    }
    struct ws_msg *m = sp->out_head;
    if (m) {
      sp->out_head = m->next;
      if (sp->out_head == NULL) sp->out_tail = NULL;
    }
    int running = sp->writer_running;
    pthread_mutex_unlock(&sp->out_mutex);

    if (!m) {
      if (!running) break;
      continue;
    }

    /* Perform the write under ws_mutex to serialize with other ws ops. */
    pthread_mutex_lock(&sp->ws_mutex);
    if (sp->ws == NULL) {
      pthread_mutex_unlock(&sp->ws_mutex);
      free(m->data); free(m);
      continue;
    }
    if (m->is_text)
      onion_websocket_set_opcode(sp->ws, OWS_TEXT);
    else
      onion_websocket_set_opcode(sp->ws, OWS_BINARY);

    /* Before performing a blocking write, poll the underlying socket for
       writability with a short timeout. This avoids blocking indefinitely
       inside `onion_websocket_write()` when the network is stalled. If we
       cannot obtain the fd or poll reports an error/timeout, treat as a
       write failure and clean up the session. */
    if (sp->ws_fd >= 0) {
      struct pollfd pfd;
      pfd.fd = sp->ws_fd;
      pfd.events = POLLOUT;
      int const timeout_ms = 500; /* match watchdog threshold */
      int pres = poll(&pfd, 1, timeout_ms);
      if (pres <= 0) {
        /* timeout or error: consider write stuck and clean session */
        fprintf(stderr, "%s: poll timeout/error (%d) on ssrc=%u, cleaning session\n", __FUNCTION__, pres, sp->ssrc);
        control_set_frequency(sp, "0");
        sp->audio_active = false;
        pthread_t spectrum_join = 0;
        if (sp->spectrum_active) {
          pthread_mutex_lock(&sp->spectrum_mutex);
          sp->spectrum_active = false;
          stop_spectrum_stream(sp);
          spectrum_join = sp->spectrum_task;
          pthread_mutex_unlock(&sp->spectrum_mutex);
        }
        sp->spectrum_requested_by_client = false;
        sp->spectrum_restart_attempts = 0;
        sp->last_spectrum_restart_ms = 0;
        sp->ws = NULL;
        sp->ws_fd = -1;
        pthread_mutex_unlock(&sp->ws_mutex);
        if (spectrum_join) pthread_join(spectrum_join, NULL);
        free(m->data); free(m);
        break;
      }
    }

    sp->write_in_progress = true;
    sp->last_write_start_ms = now_ms();
    int r = onion_websocket_write(sp->ws, (char *)m->data, m->size);
    sp->write_in_progress = false;
    if (r <= 0) {
      fprintf(stderr, "%s: onion_websocket_write returned %d for ssrc=%u, cleaning session\n", __FUNCTION__, r, sp->ssrc);
      /* On failure, perform cleanup similar to prior helpers. */
      control_set_frequency(sp, "0");
      sp->audio_active = false;
      pthread_t spectrum_join = 0;
      if (sp->spectrum_active) {
        pthread_mutex_lock(&sp->spectrum_mutex);
        sp->spectrum_active = false;
        stop_spectrum_stream(sp);
        spectrum_join = sp->spectrum_task;
        pthread_mutex_unlock(&sp->spectrum_mutex);
      }
      sp->spectrum_requested_by_client = false;
      sp->spectrum_restart_attempts = 0;
      sp->last_spectrum_restart_ms = 0;
      sp->ws = NULL;
      sp->ws_fd = -1;
      pthread_mutex_unlock(&sp->ws_mutex);
      if (spectrum_join) pthread_join(spectrum_join, NULL);
      free(m->data); free(m);
      /* After a failed write we break out and allow deletion to proceed */
      break;
    }
    pthread_mutex_unlock(&sp->ws_mutex);
    free(m->data); free(m);
  }
  return NULL;
}

/* Helper: scan TLV buffer for presence of a type without fully decoding */
static bool tlv_has_type(uint8_t const *buf, int len, enum status_type want)
{
  uint8_t const *cp = buf;
  uint8_t const *end = buf + len;
  while(cp < end){
    enum status_type type = *cp++;
    if(type == EOL)
      break;
    if(cp >= end)
      break;
    unsigned int optlen = *cp++;
    if(optlen & 0x80){
      int length_of_length = optlen & 0x7f;
      optlen = 0;
      if(cp + length_of_length > end)
        break;
      while(length_of_length > 0){
        optlen <<= 8;
        optlen |= *cp++;
        length_of_length--;
      }
    }
    if(cp + optlen > end)
      break;
    if(type == want)
      return true;
    cp += optlen;
  }
  return false;
}

/*
  process_spectrum_packet
  ------------------------
  Handle an incoming spectrum STATUS packet for a given session and forward a packed
  spectrum RTP payload to the web browser client.

  - Inputs: `sp` is the session (even SSRC); `buffer`/`rx_length` contain the received
    STATUS TLV payload (the incoming packet carries the spectrum SSRC = `sp->ssrc+1`).
  - Steps performed:
      1) Call `decode_radio_status()` to refresh `Frontend`/`Channel` state.
      2) Build an RTP header and serialize session/frontend metadata into `output_buffer`.
      3) Call `extract_powers()` (using `sp->ssrc + 1`) to decode BIN_DATA/BIN_BYTE_DATA
         into a float `powers[]` array.
      4) Pack the decoded power values into the output buffer and send them to the web
         browser client via `send_ws_binary_to_session()`.
  - Notes:
      * `extract_powers()` / `handle_bin_data()` compute `sp->bins_min_db` and
        `sp->bins_max_db`, but this function does not perform any automatic
        rescaling/autoranging of the outgoing payload.
*/
/* Outgoing spectrum RTP packets must carry the spectrum SSRC (sp->ssrc + 1).
  Using sp->ssrc+1 for spectrum ensures the browser can disambiguate spectrum
  frames from the audio/status stream when multiple clients are connected. */
static void process_spectrum_packet(struct session *sp, uint8_t *buffer, int rx_length)
{
  struct rtp_header rtp;
  uint8_t output_buffer[PKTSIZE];
  float powers[PKTSIZE / sizeof(float)];
  uint64_t time;
  double r_freq, r_bin_bw;

  /* Update status values early (keeps some fields fresh) */
  decode_radio_status(&Frontend, &Channel, buffer + 1, rx_length - 1);

  memset(&rtp, 0, sizeof(rtp));
  rtp.type = 0x7F; /* spectrum data */
  rtp.version = RTP_VERS;
  /* Use the spectrum SSRC (sp->ssrc + 1) for outgoing spectrum RTP packets */
  rtp.ssrc = sp->ssrc + 1;
  rtp.marker = true;
  rtp.seq = rtp_seq++;

  uint8_t *bp = (uint8_t *)hton_rtp((char *)output_buffer, &rtp);

  uint32_t *ip = (uint32_t *)bp;
  *ip++ = htonl(sp->bins);
  *ip++ = htonl(sp->center_frequency);
  *ip++ = htonl(sp->frequency);
  *ip++ = htonl(sp->bin_width);

  *ip++ = (uint32_t)round(fabs(Frontend.samprate));
  *ip++ = (uint32_t)Frontend.rf_agc;
  *(uint64_t *)ip = (uint64_t)Frontend.samples; ip += 2;
  *(uint64_t *)ip = (uint64_t)Frontend.overranges; ip += 2;
  *(uint64_t *)ip = (uint64_t)Frontend.samp_since_over; ip += 2;
  *(uint64_t *)ip = (uint64_t)Channel.clocktime; ip += 2;
  *(float *)ip++ = (float)Channel.spectrum.noise_bw;
  *(float *)ip++ = (float)Frontend.rf_atten;
  *(float *)ip++ = (float)Frontend.rf_gain;
  *(float *)ip++ = (float)Frontend.rf_level_cal;
  *(float *)ip++ = (float)power2dB(Frontend.if_power);
  *(float *)ip++ = (float)sp->noise_density_audio;
  *ip++ = (uint32_t)sp->zoom_index;
  *(float *)ip++ = (float)Channel.spectrum.base;
  *(float *)ip++ = (float)Channel.spectrum.step;

  int header_size = (uint8_t *)ip - &output_buffer[0];
  int length = (PKTSIZE - header_size) / sizeof(float);

  int npower = extract_powers(powers, length, &time, &r_freq, &r_bin_bw,
                              sp->ssrc + 1, buffer + 1, rx_length - 1, sp);
  if (npower < 0)
    return;

  uint8_t *fp = (uint8_t *)ip;
  for (int i = 0; i < npower; i++) {
    *fp++ = powers[i];
  }
  int size = (uint8_t *)fp - &output_buffer[0];

  send_ws_binary_to_session(sp, output_buffer, size);
}

/*
  process_status_packet
  ----------------------
  Handle an incoming regular STATUS packet for a session and forward radio/status
  metadata (and notifications) to the web browser client.

  - Inputs: `sp` is the session (even SSRC); `buffer`/`rx_length` contain the received
   STATUS TLV payload for that session.
  - Actions performed:
    1) Optionally detect explicit TLVs (e.g., SHIFT_FREQUENCY) using `tlv_has_type()` and
      call `decode_radio_status()` to update `Frontend`/`Channel`.
    2) Extract noise density via `extract_noise()` and update `sp->noise_density_audio`.
    3) Perform preset and frequency mismatch detection/adoption logic and send
      textual notifications to the client (e.g., `M:<preset>`, `BFREQ:<freq>`)
      via `send_ws_text_to_session()` when appropriate.
    4) Broadcast readiness for audio output socket via `output_dest_socket_cond` if set.
    5) Build a status RTP payload (baseband power, filter edges, optional description)
      and send it to the browser via `send_ws_binary_to_session()`.
  - Notes:
    * `last_sent_backend_frequency` is used to avoid redundant BFREQ notifications.
    * The function relies on helper wrappers (send_ws_*) to perform websocket I/O
      with proper locking.
*/
static void process_status_packet(struct session *sp, uint8_t *buffer, int rx_length,
                       double *last_sent_backend_frequency)
{
  uint8_t output_buffer[PKTSIZE];
  /* Detect whether this status packet contains an explicit SHIFT_FREQUENCY TLV */
  bool have_shift = tlv_has_type(buffer + 1, rx_length - 1, SHIFT_FREQUENCY);
  decode_radio_status(&Frontend, &Channel, buffer + 1, rx_length - 1);

  if (have_shift) {
    double new_shift = Channel.tune.shift;
    double old_shift = sp->shift;
    if (isnan(sp->shift) || sp->shift != new_shift) {
      sp->shift = new_shift;
      if (verbose)
        fprintf(stderr, "SSRC %u: received shift %.6f Hz\n", sp->ssrc, new_shift);
      /* Always notify web client that backend reports a new per-session
         shift value. Do not gate SHIFT notifications on adoptOnParameterMismatch. */
      {
        char shift_msg[64];
        snprintf(shift_msg, sizeof(shift_msg), "SHIFT:%.3f", new_shift);
        send_ws_text_to_session(sp, shift_msg);
      }

      /* Special-case: if this session recently requested a mode change
         leaving CWU/CWL and the backend has just cleared the CW shift,
         immediately adopt the backend un-shifted tuned frequency so the
         session does not remain tuned to the (now invalid) shifted value.
         This bypasses adoptOnParameterMismatch for the specific CW->non-CW
         transition. */
      if (sp->left_cw_pending) {
        const double SHIFT_CLEAR_EPS_HZ = 0.5;
        unsigned long now = now_ms();
        if (!isnan(old_shift) && fabs(old_shift) > SHIFT_CLEAR_EPS_HZ && fabs(new_shift) <= SHIFT_CLEAR_EPS_HZ) {
          /* Ensure the backend preset is no longer CW */
          if (!(strncasecmp(Channel.preset, "cwu", 3) == 0 || strncasecmp(Channel.preset, "cwl", 3) == 0)) {
            /* reasonable time window: 5 seconds */
            if (now - sp->left_cw_time_ms <= 5000UL) {
              if (verbose)
                fprintf(stderr, "SSRC %u: adopting polled freq %.3f kHz due to recent CW->non-CW mode change (shift=%.3f Hz)\n",
                        sp->ssrc, Channel.tune.freq * 0.001, new_shift);
              sp->frequency = (uint32_t)lround(Channel.tune.freq);
              char freq_msg[64];
              snprintf(freq_msg, sizeof(freq_msg), "BFREQ:%.3f", Channel.tune.freq);
              send_ws_text_to_session(sp, freq_msg);
              *last_sent_backend_frequency = Channel.tune.freq;
              sp->left_cw_pending = 0;
            }
          }
        }
      }

      /* Special-case: if this session recently toggled between CWU and CWL
         (flip), the backend will move the carrier by the sum/difference of
         the two shift values (effectively double the shift). Accept that
         backend frequency immediately if it matches the expected flip delta. */
      if (sp->cw_flip_pending) {
        const double SHIFT_FLIP_EPS_HZ = 0.5;
        unsigned long now = now_ms();
        if (!isnan(old_shift) && !isnan(new_shift)) {
          double flip_delta = fabs(old_shift - new_shift);
          double freq_diff = fabs(Channel.tune.freq - (double)sp->frequency);
          /* reasonable time window: 5 seconds */
          if (now - sp->cw_flip_time_ms <= 5000UL && fabs(freq_diff - flip_delta) <= SHIFT_FLIP_EPS_HZ) {
            if (verbose)
              fprintf(stderr, "SSRC %u: adopting polled freq %.3f kHz due to CWU/CWL flip (flip_delta=%.3f Hz)\n",
                      sp->ssrc, Channel.tune.freq * 0.001, flip_delta);
            sp->frequency = (uint32_t)lround(Channel.tune.freq);
            char freq_msg[64];
            snprintf(freq_msg, sizeof(freq_msg), "BFREQ:%.3f", Channel.tune.freq);
            send_ws_text_to_session(sp, freq_msg);
            *last_sent_backend_frequency = Channel.tune.freq;
            sp->cw_flip_pending = 0;
            sp->freq_mismatch_count = 0;
          } else if (now - sp->cw_flip_time_ms > 5000UL) {
            /* timeout window expired */
            sp->cw_flip_pending = 0;
          }
        } else {
          sp->cw_flip_pending = 0;
        }
      }
    }
  }

  float n0 = 0.0f;
  if (0 == extract_noise(&n0, buffer + 1, rx_length - 1, sp))
    sp->noise_density_audio = n0;

  /* Handle preset mismatch / adoption */
  if (strncmp(Channel.preset, sp->requested_preset, sizeof(sp->requested_preset))) {
    /* Decide whether to adopt a backend-changed preset (because no recent
       local client command exists) or to retry our requested preset. */
    const int MAX_PRESET_MISMATCH = 5;
    const unsigned long CLIENT_CMD_WINDOW_MS = 5000UL;
    unsigned long now = now_ms();
    bool client_recent = ((sp->last_client_command_ms != 0) && (now - sp->last_client_command_ms <= CLIENT_CMD_WINDOW_MS))
               || ((sp->reattach_time_ms != 0) && (now - sp->reattach_time_ms <= CLIENT_CMD_WINDOW_MS));

    if (!client_recent) {
      /* No recent local client command: adopt backend-reported preset and notify client. */
      if (verbose && debug_send) {
        unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
        fprintf(stderr, "%s: +%lums: SSRC %u: adopting polled preset %s (no recent local command)\n",
                __FUNCTION__, elapsed_ms, sp->ssrc, Channel.preset);
      }
      if (debug_send) {
        fprintf(stderr, "%s: preset_adopt: SSRC %u adopting backend preset '%s' -> sending M_FORCE to client\n", __FUNCTION__, sp->ssrc, Channel.preset);
      }
      strlcpy(sp->requested_preset, Channel.preset, sizeof(sp->requested_preset));
      sp->preset_mismatch_count = 0;
      sp->last_client_command_ms = 0;
      /* Notify this client so its UI can update (force update) */
      char pm[64];
      snprintf(pm, sizeof(pm), "M_FORCE:%s", sp->requested_preset);
      send_ws_text_to_session(sp, pm);
    } else {
      /* Recent local command exists; track mismatches and resend after threshold. */
      sp->preset_mismatch_count++;
      if (verbose && debug_send) {
        unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
        fprintf(stderr, "%s: +%lums: SSRC %u requested preset %s, but poll returned preset %s (mismatch %d/%d)\n",
                __FUNCTION__, elapsed_ms, sp->ssrc, sp->requested_preset, Channel.preset, sp->preset_mismatch_count, MAX_PRESET_MISMATCH);
      }
      if (sp->preset_mismatch_count >= MAX_PRESET_MISMATCH) {
        if (verbose && debug_send) {
          unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
          fprintf(stderr, "%s: +%lums: SSRC %u: resending requested preset %s after %d mismatches\n",
                  __FUNCTION__, elapsed_ms, sp->ssrc, sp->requested_preset, MAX_PRESET_MISMATCH);
        }
        control_set_mode(sp, sp->requested_preset);
        sp->preset_mismatch_count = 0;
      }
    }
  } else {
    /* Preset matches; if we previously recorded mismatches, log that they
       have now been satisfied before clearing the counter. */
    if (sp->preset_mismatch_count != 0) {
      if (verbose && debug_send) {
        unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
        fprintf(stderr, "%s: +%lums: SSRC %u: preset mismatch satisfied: requested %s now polled as %s (cleared after %d mismatches)\n",
                __FUNCTION__, elapsed_ms, sp->ssrc, sp->requested_preset, Channel.preset, sp->preset_mismatch_count);
      }
    }
    sp->preset_mismatch_count = 0;
  }

  /* Backend frequency change -> notify client (tolerant comparison)
     Use a small tolerance to prevent tiny floating-point differences from
     causing repeated notifications or false mismatch detection. */
  {
    const double FREQ_EPS_HZ = 0.5; /* 0.5 Hz tolerance */
    bool backend_changed = isnan(*last_sent_backend_frequency) ||
                           (fabs(*last_sent_backend_frequency - Channel.tune.freq) > FREQ_EPS_HZ);
      if (backend_changed) {
      /* Always notify client of backend frequency changes; server state is authoritative. */
      current_backend_frequency = Channel.tune.freq;
      char freq_msg[64];
      snprintf(freq_msg, sizeof(freq_msg), "BFREQ:%.3f", current_backend_frequency);
      send_ws_text_to_session(sp, freq_msg);
      *last_sent_backend_frequency = Channel.tune.freq;
    }
  }

  /* Frequency mismatch handling (adopt/resend logic) with tolerant comparison */
  {
    const int MAX_FREQ_MISMATCH = 5;
    const double FREQ_EPS_HZ = 0.5; /* same tolerance used above */
    double backend_freq = Channel.tune.freq;
    double session_freq = (double)sp->frequency;
    double diff = fabs(backend_freq - session_freq);

    if (diff <= FREQ_EPS_HZ) {
      /* Considered matched */
      if (sp->freq_mismatch_count != 0) {
        int prev_count = sp->freq_mismatch_count;
        if (verbose && debug_send) {
          unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
          fprintf(stderr, "%s: +%lums: SSRC %u: frequency mismatch satisfied: session %.3f kHz vs backend %.3f kHz (cleared after %d mismatches)\n",
                  __FUNCTION__, elapsed_ms, sp->ssrc, 0.001 * sp->frequency, 0.001 * Channel.tune.freq, prev_count);
        }
        sp->freq_mismatch_count = 0;
      }
    } else {
      /* Special-case: in CWU or CWL mode the backend reports the carrier
         moved by the CW shift; if the frequency difference equals the
         per-session `shift`, adopt immediately regardless of
         `adoptOnParameterMismatch`. This avoids spurious mismatch churn
         when a CW preset adjusts the carrier by the audio shift amount. */
      if ((strncmp(Channel.preset, "cwu", 3) == 0 || strncmp(Channel.preset, "cwl", 3) == 0)
          && !isnan(sp->shift)
          && fabs(diff - fabs(sp->shift)) <= FREQ_EPS_HZ) {
        if (verbose && debug_send) {
          unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
          fprintf(stderr, "%s: +%lums: SSRC %u: adopting polled freq %.3f kHz due to CWU/CWL shift match (shift=%.3f Hz)\n",
            __FUNCTION__, elapsed_ms, sp->ssrc, Channel.tune.freq * 0.001, sp->shift);
        }
        sp->frequency = (uint32_t)lround(Channel.tune.freq);
        char freq_msg[64];
        snprintf(freq_msg, sizeof(freq_msg), "BFREQ:%.3f", Channel.tune.freq);
        send_ws_text_to_session(sp, freq_msg);
        *last_sent_backend_frequency = Channel.tune.freq;
        sp->freq_mismatch_count = 0;
      } else {
        const unsigned long CLIENT_CMD_WINDOW_MS = 5000UL;
        unsigned long now = now_ms();
        bool client_recent = ((sp->last_client_command_ms != 0) && (now - sp->last_client_command_ms <= CLIENT_CMD_WINDOW_MS))
                 || ((sp->reattach_time_ms != 0) && (now - sp->reattach_time_ms <= CLIENT_CMD_WINDOW_MS));

        if (!client_recent) {
          /* No recent local client command: adopt backend frequency and notify client. */
          if (verbose && debug_send) {
            unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
            fprintf(stderr, "%s: +%lums: SSRC %u: adopting polled freq %.3f kHz (no recent local command)\n",
                    __FUNCTION__, elapsed_ms, sp->ssrc, Channel.tune.freq * 0.001);
          }
          sp->frequency = (uint32_t)lround(Channel.tune.freq);
          char freq_msg[64];
          snprintf(freq_msg, sizeof(freq_msg), "BFREQ_FORCE:%.3f", Channel.tune.freq);
          send_ws_text_to_session(sp, freq_msg);
          /* Keep last_sent_backend_frequency in sync when we actually notify */
          *last_sent_backend_frequency = Channel.tune.freq;
          sp->freq_mismatch_count = 0;
          sp->last_client_command_ms = 0;
        } else {
          sp->freq_mismatch_count++;
          if(verbose && debug_send) {
            unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
            fprintf(stderr, "%s: +%lums: SSRC %u: frequency mismatch: session %.3f kHz vs backend %.3f kHz (diff=%.3f Hz, mismatch count %d/%d)\n",
              __FUNCTION__, elapsed_ms, sp->ssrc, 0.001 * sp->frequency, 0.001 * Channel.tune.freq, diff, sp->freq_mismatch_count, MAX_FREQ_MISMATCH);
          }
          if (sp->freq_mismatch_count >= MAX_FREQ_MISMATCH) {
            /* After repeated mismatches reassert our requested frequency by
               resending it to the backend rather than adopting the polled value. */
            if (verbose && debug_send) {
              unsigned long elapsed_ms = poll_start_ms ? (now_ms() - poll_start_ms) : 0UL;
              fprintf(stderr, "%s: +%lums: SSRC %u: resending requested freq %.3f kHz after %d mismatches\n",
                      __FUNCTION__, elapsed_ms, sp->ssrc, sp->frequency * 0.001, MAX_FREQ_MISMATCH);
            }
            {
              char freq_msg[64];
              snprintf(freq_msg, sizeof(freq_msg), "%.3f", sp->frequency * 0.001);
              control_set_frequency(sp, freq_msg);
            }
            sp->freq_mismatch_count = 0;
          }
        }
      }
    }
  }

  pthread_mutex_lock(&output_dest_socket_mutex);
  if (Channel.output.dest_socket.sa_family != 0)
    pthread_cond_broadcast(&output_dest_socket_cond);
  pthread_mutex_unlock(&output_dest_socket_mutex);

  struct rtp_header rtp;
  memset(&rtp, 0, sizeof(rtp));
  rtp.type = 0x7E; /* radio data */
  rtp.version = RTP_VERS;
  rtp.ssrc = sp->ssrc;
  rtp.marker = true;
  rtp.seq = rtp_seq++;
  uint8_t *bp = (uint8_t *)hton_rtp((char *)output_buffer, &rtp);
  encode_float(&bp, BASEBAND_POWER, Channel.sig.bb_power);
  encode_float(&bp, LOW_EDGE, Channel.filter.min_IF);
  encode_float(&bp, HIGH_EDGE, Channel.filter.max_IF);
  if (!sp->once) {
    sp->once = true;
    if (description_override)
      encode_string(&bp, DESCRIPTION, description_override, strlen(description_override));
    else
      encode_string(&bp, DESCRIPTION, Frontend.description, strlen(Frontend.description));
  }
  int size = (uint8_t *)bp - output_buffer;
  send_ws_binary_to_session(sp, output_buffer, size);
}


