#ifndef _RTP_H
#define _RTP_H 1

#define DEFAULT_MCAST_PORT (5004)
#define DEFAULT_RTP_PORT (5004)
#define DEFAULT_RTCP_PORT (5005)
#define DEFAULT_STAT_PORT (5006)

#define NTP_EPOCH 2208988800UL

#define RTP_MIN_SIZE 12
#define RTP_VERS 2U
#define RTP_MARKER 0x80

enum encoding {
  NO_ENCODING = 0,
  S16LE,
  S16BE,
  OPUS,
  F32LE,
  AX25,
  F16LE,
  UNUSED_ENCODING,
};
struct pt_table {
  unsigned int samprate;
  unsigned int channels;
  enum encoding encoding;
};

extern struct pt_table PT_table[];
extern int const Opus_pt;
extern int const AX25_pt;

struct rtp_header {
  int version;
  uint8_t type;
  uint16_t seq;
  uint32_t timestamp;
  uint32_t ssrc;
  bool marker:1;
  bool pad:1;
  bool extension:1;
  int cc;
  uint32_t csrc[15];
};

struct rtp_state {
  uint32_t ssrc;
  uint8_t type;
  bool init;
  uint16_t seq;
  uint16_t odd_seq;
  bool odd_seq_set;
  uint32_t timestamp;
  uint64_t packets;
  uint64_t bytes;
  uint64_t drops;
  uint64_t dupes;
};

struct rtcp_sr {
  uint32_t ssrc;
  int64_t ntp_timestamp;
  unsigned int rtp_timestamp;
  unsigned int packet_count;
  unsigned int byte_count;
};

struct rtcp_rr {
  uint32_t ssrc;
  int lost_fract;
  int lost_packets;
  int highest_seq;
  int jitter;
  int lsr;
  int dlsr;
};

enum sdes_type {
  CNAME=1,
  NAME=2,
  EMAIL=3,
  PHONE=4,
  LOC=5,
  TOOL=6,
  NOTE=7,
  PRIV=8,
};

struct rtcp_sdes {
  enum sdes_type type;
  uint32_t ssrc;
  int mlen;
  char message[256];
};
#define PKTSIZE 65536

struct packet {
  struct packet *next;
  struct rtp_header rtp;
  uint8_t const *data;
  size_t len;
  uint8_t content[PKTSIZE];
};

void const *ntoh_rtp(struct rtp_header *,void const *);
void *hton_rtp(void *, struct rtp_header const *);
int add_pt(int type, unsigned int samprate, unsigned int channels, enum encoding encoding);
int rtp_process(struct rtp_state *state,struct rtp_header const *rtp,int samples);
uint8_t *gen_sdes(uint8_t *output,int bufsize,uint32_t ssrc,struct rtcp_sdes const *sdes,int sc);
uint8_t *gen_bye(uint8_t *output,int bufsize,uint32_t const *ssrcs,int sc);
uint8_t *gen_sr(uint8_t *output,int bufsize,struct rtcp_sr const *sr,struct rtcp_rr const *rr,int rc);
uint8_t *gen_rr(uint8_t *output,int bufsize,uint32_t ssrc,struct rtcp_rr const *rr,int rc);

#endif
