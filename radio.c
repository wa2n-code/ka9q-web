// Minimal compatibility layer copied/adapted from ka9q-radio
// Provides the symbols used by ka9q-web.c so the project can build standalone.

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#include "radio.h"

/* Local definitions */
#define CMD 0x01


// Simple no-op implementations to allow linking and basic operation.
int resolve_mcast(char const *target, void *sock, int default_port, char *iface, int iface_len, int tries) {
  (void)target; (void)sock; (void)default_port; (void)iface; (void)iface_len; (void)tries;
  return 0;
}

int listen_mcast(void const *source, void const *sock, char const *iface){
  (void)source; (void)sock; (void)iface;
  return -1;
}

int connect_mcast(void const * const s, char const * const iface, int const ttl, int const tos){
  (void)s; (void)iface; (void)ttl; (void)tos;
  return -1;
}

// Encoding helpers: they advance the buffer pointer and write simple TLV-style values.
static void write_u8(uint8_t **bp, uint8_t v){ **bp = v; (*bp)++; }
static void write_u32(uint8_t **bp, uint32_t v){ memcpy(*bp,&v,4); (*bp)+=4; }
static void write_double(uint8_t **bp, double d){ memcpy(*bp,&d,sizeof(double)); (*bp)+=sizeof(double); }
static void write_float(uint8_t **bp, float f){ memcpy(*bp,&f,sizeof(float)); (*bp)+=sizeof(float); }

int encode_double(uint8_t **bp, enum status_type type, double value){ write_u8(bp, (uint8_t)type); write_double(bp, value); return 0; }
int encode_int(uint8_t **bp, enum status_type type, int value){ write_u8(bp, (uint8_t)type); write_u32(bp, (uint32_t)value); return 0; }
int encode_float(uint8_t **bp, enum status_type type, float value){ write_u8(bp,(uint8_t)type); write_float(bp,value); return 0; }
int encode_string(uint8_t **bp, enum status_type type, void const *s, unsigned int len){ write_u8(bp,(uint8_t)type); if(len>0){ memcpy(*bp,s,len); (*bp)+=len; } return 0; }
int encode_eol(uint8_t **bp){ write_u8(bp,0xFF); return 0; }

// Decoding helpers used by ka9q-web.c
static double read_double(const uint8_t *p){ double d; memcpy(&d,p,sizeof(double)); return d; }
static float read_float(const uint8_t *p){ float f; memcpy(&f,p,sizeof(float)); return f; }
static uint32_t read_u32(const uint8_t *p){ uint32_t v; memcpy(&v,p,4); return v; }

double decode_double(const uint8_t *p,int len){ (void)len; return read_double(p); }
float decode_float(const uint8_t *p,int len){ (void)len; return read_float(p); }
int decode_int(const uint8_t *p,int len){ (void)len; return (int)read_u32(p); }
uint32_t decode_int32(const uint8_t *p,int len){ (void)len; return (uint32_t)read_u32(p); }
uint64_t decode_int64(const uint8_t *p,int len){ (void)len; uint64_t v=0; memcpy(&v,p,8); return v; }

// A minimal ntoh_rtp that returns pointer to payload (after header)
void const *ntoh_rtp(struct rtp_header *hdr, void const *content) {
  // Attempt to parse a simple RTP header from content and fill hdr if provided
  if(content==NULL) return NULL;
  if(hdr){
    memset(hdr,0,sizeof(*hdr));
    /* try to extract ssrc if buffer long enough */
    const uint8_t *c = (const uint8_t *)content;
    if(12 <= PKTSIZE){
      uint32_t ssrc;
      memcpy(&ssrc, c+8, 4);
      hdr->ssrc = ntohl(ssrc);
    }
  }
  return (const uint8_t *)content + 12;
}

// Minimal stub for decode_radio_status used by ka9q-web.c
int decode_radio_status(struct frontend *frontend, struct channel *channel, uint8_t const *buf, int len){
  (void)frontend; (void)channel; (void)buf; (void)len;
  return 0;
}

// Minimal extract_powers/extract_noise prototypes to satisfy linking if needed elsewhere
int extract_powers(float *power,int npower,uint64_t *time,double *freq,double *bin_bw,int32_t const ssrc,uint8_t const * const buffer,int length,void *sp){
  (void)power;(void)npower;(void)time;(void)freq;(void)bin_bw;(void)ssrc;(void)buffer;(void)length;(void)sp;
  return 0;
}

int extract_noise(float *n0,uint8_t const * const buffer,int length,void *sp){
  (void)n0;(void)buffer;(void)length;(void)sp; return 0;
}

/* Convert sockaddr to printable string. Minimal implementation. */
char const *formatsock(void const *sa, bool numeric){
  static char buf[64];
  if(!sa) return "(null)";
  struct sockaddr const *ssa = (struct sockaddr const *)sa;
  if(ssa->sa_family == AF_INET){
    struct sockaddr_in const *in = (struct sockaddr_in const*)ssa;
    snprintf(buf,sizeof(buf),"%s:%u",inet_ntoa(in->sin_addr),ntohs(in->sin_port));
  } else if(ssa->sa_family == AF_INET6){
    snprintf(buf,sizeof(buf),"[ipv6]");
  } else {
    snprintf(buf,sizeof(buf),"(unknown family %d)",ssa->sa_family);
  }
  (void)numeric;
  return buf;
}

/* Extract SSRC from a buffer if present (assumes SSRC at offset 8) */
uint32_t get_ssrc(uint8_t const *buf, int len){
  if(!buf || len < 12) return 0;
  uint32_t ssrc;
  memcpy(&ssrc, buf+8, 4);
  return ntohl(ssrc);
}

/* hton_rtp: write a minimal RTP header into out and return pointer to next byte */
void *hton_rtp(void *out, struct rtp_header const *hdr){
  if(!out || !hdr) return NULL;
  uint8_t *p = (uint8_t*)out;
  *p++ = 0x80;
  *p++ = 0;
  uint16_t seq = htons(hdr->seq);
  memcpy(p,&seq,2); p+=2;
  uint32_t ts = htonl(hdr->timestamp);
  memcpy(p,&ts,4); p+=4;
  uint32_t ssrc = htonl(hdr->ssrc);
  memcpy(p,&ssrc,4); p+=4;
  return p;
}
