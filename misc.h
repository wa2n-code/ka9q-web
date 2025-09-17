// Miscellaneous constants, macros and function prototypes for ka9q-radio
#ifndef _MISC_H
#define _MISC_H 1

#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#include <pthread.h>
#include <stdint.h>
#include <limits.h>
#include <complex.h>
#include <math.h>
#include <stdlib.h>
#include <stdbool.h>
#include <sys/errno.h>
#ifdef __linux__
#include <bsd/string.h>
#endif
#include <assert.h>

#define VERSION() { fprintf(stderr,"KA9Q Multichannel SDR %s last modified %s\n",__FILE__,__TIMESTAMP__); \
            fprintf(stderr,"Copyright 2025, Phil Karn, KA9Q. May be used under the terms of the GNU Public License\n");}

static inline void ASSERT_UNLOCKED(pthread_mutex_t *mutex){
#ifndef NDEBUG
  int rc = pthread_mutex_trylock(mutex);
  assert(rc != EBUSY);
  pthread_mutex_unlock(mutex);
#else
  (void)mutex;
#endif
}

#ifndef M_PIf
#define M_PIf ((float)(M_PI))
#endif
#ifndef M_1_PIf
#define M_1_PIf (1 / M_PIf)
#endif

#define M_1_2PIf (0.5f * M_1_PIf)
#define DEGPRA (180./M_PI)
#define RAPDEG (M_PI/180.)
#define GPS_UTC_OFFSET (18)
#define UNIX_EPOCH ((time_t)315964800)

#define BOLTZMANN (1.380649e-23)

static float const SCALE16 = 1./INT16_MAX;
static float const SCALE12 = 1/2048.;
static float const SCALE8 = 1./INT8_MAX;

int default_prio(void);
void realtime(int prio);
int norealtime(void);
void stick_core(void);
void *lmalloc(size_t size);

inline static float sinc(float x){
  if(x == 0)
    return 1;
  return sinf(M_PI * x) / (M_PI * x);
}

extern const char *App_path;
extern int Verbose;
extern char const *Months[12];
extern bool Affinity;

int dist_path(char *path,int path_len,const char *fname);
char *format_gpstime(char *result,int len,int64_t t);
char *format_gpstime_iso8601(char *result,int len,int64_t t);
char *format_utctime(char *result,int len,int64_t t);
char *format_utctime_iso8601(char *result,int len,int64_t t);
char *ftime(char *result,int size,int64_t t);
void normalize_time(struct timespec *x);
double parse_frequency(char const *,bool);
uint32_t nextfastfft(uint32_t n);
int pipefill(int,void *,int);
void chomp(char *);
char *ensure_suffix(char const *str, char const *suffix);
uint32_t ElfHash(uint8_t const *s,int length);
uint32_t ElfHashString(char const *s);
uint32_t fnv1hash(const uint8_t *s,int length);

long long gps_time_ns(void);

float i0(float const z);
float i1(float const z);

float xi(float thetasq);
float fm_snr(float r);

inline static int16_t scaleclip(float const x){
  return (x >= 1.0) ? INT16_MAX : (x <= -1.0) ? -INT16_MAX : (int16_t)(INT16_MAX * x);
}

/* Forward declaration so inline helpers can call without implicit-declaration warnings */
void sincospif(float x, float *s, float *c);

static inline float complex csincosf(float const x){
  float s,c;
  sincosf(x,&s,&c);
  return CMPLXF(c,s);
}

static inline float complex csincospif(float const x){
  float s,c;
  sincospif(x,&s,&c);
  return CMPLXF(c,s);
}

static inline float cnrmf(float complex const x){
  return crealf(x)*crealf(x) + cimagf(x) * cimagf(x);
}

static long long const BILLION = 1000000000LL;

void *mirror_alloc(size_t size);
void mirror_free(void **p,size_t size);
size_t round_to_page(size_t size);
uint32_t round2(uint32_t v);
void drop_cache(void *mem,size_t bytes);

/* Small helpers/macros borrowed from upstream misc.h */
#define FREE(p) (free(p), p = NULL)

/* dB/power/voltage helpers */
#ifndef dB2power
#define dB2power(x) (powf(10.0f, (x) / 10.0f))
#endif
#ifndef dB2voltage
#define dB2voltage(x) (powf(10.0f, (x) / 20.0f))
#endif

/* Prototype for sincospif used by inline helpers */
void sincospif(float x, float *s, float *c);

/* mirror_wrap: ensure pointer stays within mirrored buffer range */
static inline void mirror_wrap(void const **p, void const * const base,size_t const size){
  if(*p == NULL) return;
  if((const uint8_t *)*p >= (const uint8_t *)base + size)
    *p = (const uint8_t *)*p - size;
}

#endif // _MISC_H
