// Minimal RTP helpers adapted from ka9q-radio/rtp.c
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <netinet/in.h>
#include "rtp.h"

struct pt_table PT_table[128] = {{0}};
int const Opus_pt = 111;
int const AX25_pt = 96;

void const *ntoh_rtp(struct rtp_header *rtp,void const *data){
  uint32_t const *dp = data;
  uint32_t const w = ntohl(*dp++);
  rtp->version = w >> 30;
  rtp->pad = (w >> 29) & 1;
  rtp->extension = (w >> 28) & 1;
  rtp->cc = (w >> 24) & 0xf;
  rtp->marker = (w >> 23) & 1;
  rtp->type = (w >> 16) & 0x7f;
  rtp->seq = w & 0xffff;
  rtp->timestamp = ntohl(*dp++);
  rtp->ssrc = ntohl(*dp++);
  for(int i=0;i<rtp->cc;i++) rtp->csrc[i] = ntohl(*dp++);
  if(rtp->extension){ int ext_len = ntohl(*dp++) & 0xffff; dp += ext_len; }
  return dp;
}

void *hton_rtp(void *data, struct rtp_header const *rtp){
  uint32_t *dp = data;
  int cc = rtp->cc & 0xf;
  *dp++ = htonl(RTP_VERS << 30 | rtp->pad << 29 | rtp->extension << 28 | cc << 24 | rtp->marker << 23
                | (rtp->type & 0x7f) << 16 | rtp->seq);
  *dp++ = htonl(rtp->timestamp);
  *dp++ = htonl(rtp->ssrc);
  for(int i=0;i<cc;i++) *dp++ = htonl(rtp->csrc[i]);
  return dp;
}
