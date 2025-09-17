// filter using fast convolution (overlap-save) and the FFTW3 FFT package
#ifndef _FILTER_H
#define _FILTER_H 1

#include <pthread.h>
#include <complex.h>
#include <stdbool.h>
#include <fftw3.h>
#include "misc.h"

extern double Fftw_plan_timelimit;
extern char const *Wisdom_file;
extern int Nthreads;
extern int FFTW_planning_level;
extern double FFTW_plan_timelimit;
extern pthread_mutex_t FFTW_planning_mutex;
extern int N_internal_threads;

enum filtertype {
  NONE,
  COMPLEX,
  BEAM,
  REAL,
  SPECTRUM,
};

struct rc {
  float *r;
  float complex *c;
};
struct notch_state {
  int bin;
  double complex state;
  double alpha;
};

#define ND 4
struct filter_in {
  enum filtertype in_type;
  int points;
  int ilen;
  int bins;
  int impulse_length;
  int wcnt;
  void *input_buffer;
  size_t input_buffer_size;
  struct rc input_write_pointer;
  struct rc input_read_pointer;
  fftwf_plan fwd_plan;

  pthread_mutex_t filter_mutex;
  pthread_cond_t filter_cond;

  struct notch_state *notches;
  float complex *fdomain[ND];
  unsigned int next_jobnum;
  unsigned int completed_jobs[ND];
  bool perform_inline;
};

struct filter_out {
  struct filter_in * restrict master;
  enum filtertype out_type;
  int points;
  int olen;
  int bins;
  double complex alpha;
  double complex beta;
  float complex * restrict fdomain;
  float complex * restrict response;
  pthread_mutex_t response_mutex;
  struct rc output_buffer;
  struct rc output;
  fftwf_plan rev_plan;
  unsigned next_jobnum;
  unsigned block_drops;
  int rcnt;
};

int create_filter_input(struct filter_in *,int const L,int const M, enum filtertype const in_type);
int create_filter_output(struct filter_out *slave,struct filter_in * restrict master,float complex * restrict response,int olen, enum filtertype out_type);
int execute_filter_input(struct filter_in * restrict);
int execute_filter_output(struct filter_out * restrict ,int);
int delete_filter_input(struct filter_in * restrict);
int delete_filter_output(struct filter_out * restrict);
int set_filter(struct filter_out * restrict,float,float,float);
void *run_fft(void *);
int write_cfilter(struct filter_in *, float complex const *,int size);
int write_rfilter(struct filter_in *, float const *,int size);
void suggest(int size,int dir,int clex);
unsigned long gcd(unsigned long a,unsigned long b);
unsigned long lcm(unsigned long a,unsigned long b);
int make_kaiser(float * const window,int const M,float const beta);
fftwf_plan plan_complex(int N, float complex *in, float complex *out, int direction);
fftwf_plan plan_r2c(int N, float *in, float complex *out);
fftwf_plan plan_c2r(int N, float complex *in, float *out);
bool goodchoice(unsigned long);
unsigned int ceil_pow2(unsigned int x);
int set_filter_weights(struct filter_out *out,double complex i_weight, double complex q_weight);

static inline int put_cfilter(struct filter_in * restrict const f,float complex const s){
  assert((void *)(f->input_write_pointer.c) >= f->input_buffer);
  assert((void *)(f->input_write_pointer.c) < f->input_buffer + f->input_buffer_size);
  *f->input_write_pointer.c++ = s;
  mirror_wrap((void *)&f->input_write_pointer.c, f->input_buffer,f->input_buffer_size);
  if(++f->wcnt >= f->ilen){
    f->wcnt -= f->ilen;
    execute_filter_input(f);
    return 1;
  }
  return 0;
}

static inline int put_rfilter(struct filter_in * restrict const f,float const s){
  assert((void *)(f->input_write_pointer.r) >= f->input_buffer);
  assert((void *)(f->input_write_pointer.r) < f->input_buffer + f->input_buffer_size);
  *f->input_write_pointer.r++ = s;
  mirror_wrap((void *)&f->input_write_pointer.r, f->input_buffer,f->input_buffer_size);
  if(++f->wcnt >= f->ilen){
    f->wcnt -= f->ilen;
    execute_filter_input(f);
    return 1;
  }
  return 0;
}

static inline float read_rfilter(struct filter_out * restrict const f,int const rotate){
  if(f->rcnt == 0){
    execute_filter_output(f,rotate);
    f->rcnt = f->olen;
  }
  return f->output.r[f->olen - f->rcnt--];
}

static inline float complex read_cfilter(struct filter_out * restrict const f,int const rotate){
  if(f->rcnt == 0){
    execute_filter_output(f,rotate);
    f->rcnt = f->olen;
  }
  return f->output.c[f->olen - f->rcnt--];
}

#endif
