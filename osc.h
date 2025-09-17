// General purpose oscillator (complex quadrature and PLL) subroutines for ka9q-radio
#ifndef _OSC_H
#define _OSC_H 1

#define _GNU_SOURCE 1
#include <pthread.h>
#include <complex.h>
#include <math.h>
#include <stdint.h>

struct osc {
  double freq;
  double rate;
  double complex phasor;
  double complex phasor_step;
  double complex phasor_step_step;
  int steps; // Steps since last normalize
};

struct pll {
  float samprate;
  uint32_t vco_phase;
  int32_t vco_step;
  float integrator_gain;
  float prop_gain;
  float integrator;
  float bw;
  float damping;
  float lower_limit;
  float upper_limit;
};

void set_osc(struct osc *osc,double f,double r);
double complex step_osc(struct osc *osc);

float sine_dds(uint32_t accum);
static inline float cos_dds(uint32_t accum){
  return sine_dds(accum + (uint32_t)0x40000000);
}
static inline float complex comp_dds(uint32_t accum){
  return CMPLXF(cos_dds(accum),sine_dds(accum));
}

void init_pll(struct pll *pll,float samprate);
float run_pll(struct pll *pll,float phase);
void set_pll_params(struct pll *pll,float bw,float damping);
void set_pll_limits(struct pll *pll,float low,float high);
static inline float complex pll_phasor(struct pll const *pll){
  return comp_dds(pll->vco_phase);
}
static inline float pll_freq(struct pll const *pll){
  return (float)pll->vco_step * pll->samprate / (float)(1LL << 32);
}

#endif
