#ifndef _RADIO_H
#define _RADIO_H 1

#include <pthread.h>
#include <complex.h>

#include <sys/socket.h>
#include <stdint.h>
#include <stdbool.h>
#include <limits.h>
#include <iniparser/iniparser.h>
#include <dlfcn.h>
#include <opus/opus.h>

#include "config.h"
#include "multicast.h"
#include "rtp.h"
#include "osc.h"
#include "status.h"
#include "filter.h"
#include "iir.h"
#include "conf.h"

enum demod_type {
  LINEAR_DEMOD = 0,
  FM_DEMOD,
  WFM_DEMOD,
  SPECT_DEMOD,
  N_DEMOD,
};

struct demodtab {
  enum demod_type type;
  char name[16];
};

extern struct demodtab Demodtab[];

char const *demod_name_from_type(enum demod_type type);
int demod_type_from_name(char const *name);

#define NSPURS 20
struct frontend {
  struct sockaddr metadata_dest_socket;
  uint64_t samples;
  uint64_t overranges;
  uint64_t samp_since_over;

  int M;
  int L;

  char description[128];
  int samprate;
  int64_t timestamp;
  double frequency;
  double calibrate;
  uint8_t lna_gain;
  uint8_t mixer_gain;
  uint8_t if_gain;

  float rf_atten;
  float rf_gain;
  bool rf_agc;
  float rf_level_cal;
  bool direct_conversion;
  bool isreal;
  int bitspersample;
  bool lock;

  float min_IF;
  float max_IF;

  float if_power;
  float if_power_max;

  pthread_mutex_t status_mutex;
  pthread_cond_t status_cond;

  void *context;
  int (*setup)(struct frontend *,dictionary *,char const *);
  int (*start)(struct frontend *);
  double (*tune)(struct frontend *,double);
  float (*gain)(struct frontend *,float);
  float (*atten)(struct frontend *,float);
  struct filter_in in;
  double spurs[NSPURS];
  pthread_mutex_t status_mutex_init;
};

struct channel {
  bool inuse;
  struct frontend *frontend;

  int lifetime;
  int prio;
  int64_t clocktime;
  struct {
    double freq;
    double shift;
    double second_LO;
    double doppler;
    double doppler_rate;
  } tune;

  struct osc fine,shift;

  struct {
    struct filter_out out;
    float min_IF;
    float max_IF;
    float kaiser_beta;
    int bin_shift;
    double remainder;
    double complex phase_adjust;
    bool beam;
    double complex a_weight;
    double complex b_weight;
  } filter;

  struct {
    struct filter_in in;
    struct filter_out out;
    float low;
    float high;
    float kaiser_beta;
    bool isb;
    unsigned int blocking;
  } filter2;

  enum demod_type demod_type;
  char preset[32];
  float complex *baseband;
  int sampcount;

  struct {
    bool env;
    bool agc;
    float hangtime;
    float recovery_rate;
    float threshold;
    int hangcount;
    double dc_tau;
  } linear;

  bool snr_squelch_enable;
  float squelch_open;
  float squelch_close;
  int squelch_tail;

  struct {
    struct pll pll;
    bool was_on;
    int lock_count;
    bool enable;
    bool square;
    bool lock;
    float loop_bw;
    float cphase;
    int64_t rotations;
    float snr;
  } pll;

  struct {
    float bb_power;
    float foffset;
    float n0;
  } sig;

  struct {
    float pdeviation;
    float tone_freq;
    float tone_deviation;
    bool threshold;
    float gain;
    float rate;
    bool stereo_enable;
    float snr;
  } fm;

  struct {
    float bin_bw;
    int bin_count;
    float *bin_data;
  } spectrum;

  struct {
    unsigned int samprate;
    float headroom;
    bool silent;
    struct rtp_state rtp;
    struct sockaddr source_socket;
    struct sockaddr dest_socket;
    char dest_string[_POSIX_HOST_NAME_MAX+20];
    unsigned int channels;
    float power;
    float deemph_state_left;
    float deemph_state_right;
    uint64_t samples;
    bool pacing;
    enum encoding encoding;
    OpusEncoder *opus;
    unsigned int opus_channels;
    unsigned int opus_bitrate;
    int opus_bandwidth;
    float *queue;
    size_t queue_size;
    unsigned wp,rp;
    unsigned minpacket;
    uint64_t errors;
    float gain;
    int ttl;
    uint32_t time_snap;
  } output;

  struct {
    uint64_t packets_in;
    uint32_t tag;
    pthread_mutex_t lock;
    uint64_t blocks_since_poll;
    int global_timer;
    int output_timer;
    int output_interval;
    uint64_t packets_out;
    struct sockaddr dest_socket;
    uint8_t *command;
    int length;
  } status;

  struct {
    struct sockaddr dest_socket;
    pthread_t thread;
  } rtcp;

  struct {
    struct sockaddr dest_socket;
    pthread_t thread;
  } sap;

  pthread_t demod_thread;
  uint64_t options;
  float tp1,tp2;
};

extern struct channel Channel_list[];
#define Nchannels 2000
extern int Channel_idle_timeout;
extern int Ctl_fd;
extern int Output_fd,Output_fd0;
extern int Output_fd_lo;
extern struct sockaddr Metadata_dest_socket;
extern int Verbose;
extern char const *Channel_keys[];
extern float Blocktime;

int loadconfig(char const *file);
struct channel *create_chan(uint32_t ssrc);
struct channel *lookup_chan(uint32_t ssrc);
int close_chan(struct channel *);
int set_defaults(struct channel *chan);
int loadpreset(struct channel *chan,dictionary const *table,char const *preset);
int start_demod(struct channel * restrict chan);
double set_freq(struct channel * restrict ,double);
double set_first_LO(struct channel const * restrict, double);

int compute_tuning(int N, int M, int samprate,int *shift,double *remainder, double freq);
int downconvert(struct channel *chan);
int set_channel_filter(struct channel *chan);
int spectrum_poll(struct channel *chan);

float scale_voltage_out2FS(struct frontend *frontend);
float scale_AD(struct frontend const *frontend);
float scale_ADpower2FS(struct frontend const *frontend);

void *radio_status(void *);

int demod_fm(void *);
int demod_wfm(void *);
int demod_linear(void *);
int demod_spectrum(void *);

int send_output(struct channel * restrict ,const float * restrict,int,bool);
int send_radio_status(struct sockaddr const *,struct frontend const *, struct channel *);
int reset_radio_status(struct channel *chan);
bool decode_radio_commands(struct channel *chan,uint8_t const *buffer,int length);
int decode_radio_status(struct frontend *frontend,struct channel *channel,uint8_t const *buffer,int length);
int flush_output(struct channel *chan,bool marker,bool complete);

unsigned int round_samprate(unsigned int x);
#endif
