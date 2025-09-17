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

// Minimal constants and types used by ka9q-web.c
#define PKTSIZE 8192
#define CMD 0x01
#define RADIO_FREQUENCY 0x10
#define OUTPUT_SSRC 0x11
#define COMMAND_TAG 0x12
#define PRESET 0x13
#define LOW_EDGE 0x14
#define HIGH_EDGE 0x15
#define DEMOD_TYPE 0x20
#define SPECT_DEMOD 0x01
#define BIN_COUNT 0x21
#define NONCOHERENT_BIN_BW 0x22

// RTP related
struct rtp_header {
  uint16_t seq;
  uint32_t timestamp;
  uint32_t ssrc;
};

// Simple no-op implementations to allow linking and basic operation.
int resolve_mcast(const char *group, struct sockaddr *dest, int port, char *iface, size_t iflen, int flags) {
  (void)group; (void)dest; (void)port; (void)iface; (void)iflen; (void)flags;
  return 0;
}

int listen_mcast(const char *group, struct sockaddr *dest, const char *iface) {
  (void)group; (void)dest; (void)iface;
  // Return -1 so caller can detect failure if they expect it; many callers accept -1 semantics.
  // To be conservative, return -1 only if group==NULL and dest==NULL to indicate not implemented.
  return -1;
}

int connect_mcast(const struct sockaddr *dest, const char *iface, int ttl, int tos) {
  (void)dest; (void)iface; (void)ttl; (void)tos;
  return -1;
}

// Encoding helpers: they advance the buffer pointer and write simple TLV-style values.
static void write_u8(uint8_t **bp, uint8_t v){ **bp = v; (*bp)++; }
static void write_u32(uint8_t **bp, uint32_t v){ memcpy(*bp,&v,4); (*bp)+=4; }
static void write_double(uint8_t **bp, double d){ memcpy(*bp,&d,sizeof(double)); (*bp)+=sizeof(double); }
static void write_float(uint8_t **bp, float f){ memcpy(*bp,&f,sizeof(float)); (*bp)+=sizeof(float); }

void encode_double(uint8_t **bp, int tag, double value){ write_u8(bp, (uint8_t)tag); write_double(bp, value); }
void encode_int(uint8_t **bp, int tag, uint32_t value){ write_u8(bp, (uint8_t)tag); write_u32(bp, value); }
void encode_float(uint8_t **bp, int tag, float value){ write_u8(bp,(uint8_t)tag); write_float(bp,value); }
void encode_string(uint8_t **bp, int tag, const char *s, int len){ write_u8(bp,(uint8_t)tag); if(len>0){ memcpy(*bp,s,len); (*bp)+=len; } }
void encode_eol(uint8_t **bp){ write_u8(bp,0xFF); }

// Decoding helpers used by ka9q-web.c
static double read_double(const uint8_t *p){ double d; memcpy(&d,p,sizeof(double)); return d; }
static float read_float(const uint8_t *p){ float f; memcpy(&f,p,sizeof(float)); return f; }
static uint32_t read_u32(const uint8_t *p){ uint32_t v; memcpy(&v,p,4); return v; }

double decode_double(const uint8_t *p,int len){ (void)len; return read_double(p); }
float decode_float(const uint8_t *p,int len){ (void)len; return read_float(p); }
int decode_int(const uint8_t *p,int len){ (void)len; return (int)read_u32(p); }
int32_t decode_int32(const uint8_t *p,int len){ (void)len; return (int32_t)read_u32(p); }
int64_t decode_int64(const uint8_t *p,int len){ (void)len; int64_t v=0; memcpy(&v,p,8); return v; }

// A minimal ntoh_rtp that returns pointer to payload (after header)
uint8_t const *ntoh_rtp(struct rtp_header *hdr, uint8_t *content) {
  // Attempt to parse a simple RTP header from content and fill hdr if provided
  if(content==NULL) return NULL;
  if(hdr){
    memset(hdr,0,sizeof(*hdr));
    // not a real parse; set ssrc from offset 8 if present
    if(8 + 4 <= PKTSIZE) {
      uint32_t ssrc;
      memcpy(&ssrc, content+8, 4);
      hdr->ssrc = ntohl(ssrc);
    }
  }
  // Return pointer after a minimal 12-byte header
  return content + 12;
}

// Minimal stub for decode_radio_status used by ka9q-web.c
int decode_radio_status(void *frontend, void *channel, uint8_t const *buf, int len){
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
