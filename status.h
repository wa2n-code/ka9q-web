// Type definitions for TLV encodings of status and commands from ka9q-radio radiod
#ifndef _STATUS_H
#define _STATUS_H 1
#include <stdio.h>
#include <stdint.h>
#include <sys/time.h>
#include <stdbool.h>

enum pkt_type {
  STATUS = 0,
  CMD,
};

enum status_type {
  EOL = 0,
  COMMAND_TAG,
  CMD_CNT,
  GPS_TIME,
  DESCRIPTION,
  STATUS_DEST_SOCKET,
  SETOPTS,
  CLEAROPTS,
  RTP_TIMESNAP,
  UNUSED4,
  INPUT_SAMPRATE,
  UNUSED6,
  UNUSED7,
  INPUT_SAMPLES,
  UNUSED8,
  UNUSED9,
  OUTPUT_DATA_SOURCE_SOCKET,
  OUTPUT_DATA_DEST_SOCKET,
  OUTPUT_SSRC,
  OUTPUT_TTL,
  OUTPUT_SAMPRATE,
  OUTPUT_METADATA_PACKETS,
  OUTPUT_DATA_PACKETS,
  OUTPUT_ERRORS,
  CALIBRATE,
  LNA_GAIN,
  MIXER_GAIN,
  IF_GAIN,
  DC_I_OFFSET,
  DC_Q_OFFSET,
  IQ_IMBALANCE,
  IQ_PHASE,
  DIRECT_CONVERSION,
  RADIO_FREQUENCY,
  FIRST_LO_FREQUENCY,
  SECOND_LO_FREQUENCY,
  SHIFT_FREQUENCY,
  DOPPLER_FREQUENCY,
  DOPPLER_FREQUENCY_RATE,
  LOW_EDGE,
  HIGH_EDGE,
  KAISER_BETA,
  FILTER_BLOCKSIZE,
  FILTER_FIR_LENGTH,
  FILTER2,
  IF_POWER,
  BASEBAND_POWER,
  NOISE_DENSITY,
  DEMOD_TYPE,
  OUTPUT_CHANNELS,
  INDEPENDENT_SIDEBAND,
  PLL_ENABLE,
  PLL_LOCK,
  PLL_SQUARE,
  PLL_PHASE,
  PLL_BW,
  ENVELOPE,
  SNR_SQUELCH,
  PLL_SNR,
  FREQ_OFFSET,
  PEAK_DEVIATION,
  PL_TONE,
  AGC_ENABLE,
  HEADROOM,
  AGC_HANGTIME,
  AGC_RECOVERY_RATE,
  FM_SNR,
  AGC_THRESHOLD,
  GAIN,
  OUTPUT_LEVEL,
  OUTPUT_SAMPLES,
  OPUS_BIT_RATE,
  MINPACKET,
  FILTER2_BLOCKSIZE,
  FILTER2_FIR_LENGTH,
  FILTER2_KAISER_BETA,
  UNUSED16,
  FILTER_DROPS,
  LOCK,
  TP1,
  TP2,
  GAINSTEP,
  AD_BITS_PER_SAMPLE,
  SQUELCH_OPEN,
  SQUELCH_CLOSE,
  PRESET,
  DEEMPH_TC,
  DEEMPH_GAIN,
  CONVERTER_OFFSET,
  PL_DEVIATION,
  THRESH_EXTEND,
  UNUSED20,
  COHERENT_BIN_SPACING,
  NONCOHERENT_BIN_BW,
  BIN_COUNT,
  UNUSED21,
  BIN_DATA,
  RF_ATTEN,
  RF_GAIN,
  RF_AGC,
  FE_LOW_EDGE,
  FE_HIGH_EDGE,
  FE_ISREAL,
  BLOCKS_SINCE_POLL,
  AD_OVER,
  RTP_PT,
  STATUS_INTERVAL,
  OUTPUT_ENCODING,
  SAMPLES_SINCE_OVER,
  PLL_WRAPS,
  RF_LEVEL_CAL,
};

int encode_string(uint8_t **bp,enum status_type type,void const *buf,unsigned int buflen);
int encode_eol(uint8_t **buf);
int encode_byte(uint8_t **buf,enum status_type type,uint8_t x);
int encode_int(uint8_t **buf,enum status_type type,int x);
int encode_int16(uint8_t **buf,enum status_type type,uint16_t x);
int encode_int32(uint8_t **buf,enum status_type type,uint32_t x);
int encode_int64(uint8_t **buf,enum status_type type,uint64_t x);
int encode_float(uint8_t **buf,enum status_type type,float x);
int encode_double(uint8_t **buf,enum status_type type,double x);
int encode_socket(uint8_t **buf,enum status_type type,void const *sock);
int encode_vector(uint8_t **buf,enum status_type type,float const *array,int size);

uint64_t decode_int64(uint8_t const *,int);
uint32_t decode_int32(uint8_t const *,int);
uint16_t decode_int16(uint8_t const *,int);
uint8_t decode_int8(uint8_t const *,int);
bool decode_bool(uint8_t const *,int);
int decode_int(uint8_t const *,int);

float decode_float(uint8_t const *,int);
double decode_double(uint8_t const *,int);
struct sockaddr *decode_socket(void *,uint8_t const *,int);
struct sockaddr *decode_local_socket(void *,uint8_t const *,int);
char *decode_string(uint8_t const *,int);
uint32_t get_ssrc(uint8_t const *buffer,int length);
uint32_t get_tag(uint8_t const *buffer,int length);

void dump_metadata(FILE *,uint8_t const *,int,bool);

#endif
