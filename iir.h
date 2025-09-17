/* Minimal iir.h copied/adapted from ka9q-radio upstream to satisfy includes. */
#ifndef IIR_H
#define IIR_H

#include <stdint.h>

/* Simple IIR filter descriptor used by radio and filter code. */
struct iir_state {
  int order;
  double *a; /* denominator coeffs (feedback) */
  double *b; /* numerator coeffs (feedforward) */
  double *x; /* input history */
  double *y; /* output history */
};

/* Allocate and initialize an IIR of given order. Returns NULL on failure. */
struct iir_state *iir_alloc(int order);
void iir_free(struct iir_state *s);
double iir_step(struct iir_state *s, double in);

#endif /* IIR_H */
