// TLV encode/decode routines (extracted from ka9q-radio status.c)
#define _GNU_SOURCE 1
#include <assert.h>
#include <string.h>
#if defined(linux)
#include <bsd/string.h>
#endif
#include <math.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <stdlib.h>
#include <stdint.h>
#include <netdb.h>

#include "misc.h"
#include "status.h"
#include "radio.h"

union result {
  uint64_t ll;
  uint32_t l;
  float f;
  double d;
};

int encode_int64(uint8_t **buf,enum status_type type,uint64_t x){
  uint8_t *cp = *buf;

  *cp++ = type;

  if(x == 0){
    *cp++ = 0;
    *buf = cp;
    return 2;
  }

  int len = sizeof(x);
  while(len > 0 && ((x >> 56) == 0)){
    x <<= 8;
    len--;
  }
  *cp++ = len;

  for(int i=0; i<len; i++){
    *cp++ = x >> 56;
    x <<= 8;
  }

  *buf = cp;
  return 2+len;
}

int encode_eol(uint8_t **buf){
  uint8_t *bp = *buf;

  *bp++ = EOL;
  *buf = bp;
  return 1;
}

int encode_byte(uint8_t **buf,enum status_type type,uint8_t x){
  uint8_t *cp = *buf;
  *cp++ = type;
  if(x == 0){
    *cp++ = 0;
    *buf = cp;
    return 2;
  }
  *cp++ = sizeof(x);
  *cp++ = x;
  *buf = cp;
  return 2+sizeof(x);
}

int encode_int16(uint8_t **buf,enum status_type type,uint16_t x){
  return encode_int64(buf,type,(uint64_t)x);
}

int encode_int32(uint8_t **buf,enum status_type type,uint32_t x){
  return encode_int64(buf,type,(uint64_t)x);
}

int encode_int(uint8_t **buf,enum status_type type,int x){
  return encode_int64(buf,type,(uint64_t)x);
}

int encode_float(uint8_t **buf,enum status_type type,float x){
  if(isnan(x))
    return 0;

  union result r;
  r.f = x;
  return encode_int32(buf,type,r.l);
}

int encode_double(uint8_t **buf,enum status_type type,double x){
  if(isnan(x))
    return 0;

  union result r;
  r.d = x;
  return encode_int64(buf,type,r.ll);
}

int encode_string(uint8_t **bp,enum status_type const type,void const *buf,unsigned int const buflen){
  uint8_t const *orig_bpp = *bp;
  uint8_t *cp = *bp;
  *cp++ = type;

  if(buflen < 128){
    *cp++ = buflen;
  } else if(buflen < 65536){
    *cp++ = 0x80 | 2;
    *cp++ = buflen >> 8;
    *cp++ = buflen;
  } else if(buflen < 16777216){
    *cp++ = 0x80 | 3;
    *cp++ = buflen >> 16;
    *cp++ = buflen >> 8;
    *cp++ = buflen;
  } else {
    *cp++ = 0x80 | 4;
    *cp++ = buflen >> 24;
    *cp++ = buflen >> 16;
    *cp++ = buflen >> 8;
    *cp++ = buflen;
  }
  memcpy(cp,buf,buflen);
  cp += buflen;
  *bp = cp;
  return cp - orig_bpp;
}

int encode_vector(uint8_t **bp,enum status_type type,float const *array,int size){
  uint8_t const *orig_bp = *bp;
  uint8_t *cp = *bp;
  *cp++ = type;

  int const bytes = sizeof(*array) * size;
  if(bytes < 128){
    *cp++ = bytes;
  } else if(bytes < 65536){
    *cp++ = 0x80 | 2;
    *cp++ = bytes >> 8;
    *cp++ = bytes;
  } else if(bytes < 16777216){
    *cp++ = 0x80 | 3;
    *cp++ = bytes >> 16;
    *cp++ = bytes >> 8;
    *cp++ = bytes;
  } else {
    *cp++ = 0x80 | 4;
    *cp++ = bytes >> 24;
    *cp++ = bytes >> 16;
    *cp++ = bytes >> 8;
    *cp++ = bytes;
  }
  for(int i=0;i < size;i++){
    union {
      uint32_t i;
      float f;
    } foo;
    foo.f = array[i];
    *cp++ = foo.i >> 24;
    *cp++ = foo.i >> 16;
    *cp++ = foo.i >> 8;
    *cp++ = foo.i;
  }
  *bp = cp;
  return cp - orig_bp;
}

char *decode_string(uint8_t const *cp,int optlen){
  char *result = malloc(optlen+1);
  if(result != NULL)
    memcpy(result,cp,optlen);
  result[optlen] = '\0';
  return result;
}

uint64_t decode_int64(uint8_t const *cp,int len){
  uint64_t result = 0;
  while(len-- > 0)
    result = (result << 8) | *cp++;

  return result;
}
uint32_t decode_int32(uint8_t const *cp,int len){
  return decode_int64(cp,len) & UINT32_MAX;
}
uint16_t decode_int16(uint8_t const *cp,int len){
  return decode_int64(cp,len) & UINT16_MAX;
}

uint8_t decode_int8(uint8_t const *cp,int len){
  return decode_int64(cp,len) & UINT8_MAX;
}
bool decode_bool(uint8_t const *cp,int len){
  return decode_int64(cp,len) ? true : false;
}

int decode_int(uint8_t const *cp,int len){
  return decode_int64(cp,len) & UINT_MAX;
}

float decode_float(uint8_t const *cp,int len){
  if(len == 0)
    return 0;

  if(len == 8)
    return (float)decode_double(cp,len);

  union result r;
  r.ll = decode_int64(cp,len);
  return r.f;
}

double decode_double(uint8_t const *cp,int len){
  if(len == 0)
    return 0;

  if(len == 4)
    return (double)decode_float(cp,len);

  union result r;
  r.ll = decode_int64(cp,len);
  return r.d;
}

int encode_socket(uint8_t **buf,enum status_type type,void const *sock){
  struct sockaddr_in const *sin = sock;
  struct sockaddr_in6 const *sin6 = sock;
  uint8_t *bp = *buf;
  int optlen = 0;

  switch(sin->sin_family){
  case AF_INET:
    optlen = 6;
    *bp++ = type;
    *bp++ = optlen;
    memcpy(bp,&sin->sin_addr.s_addr,4);
    bp += 4;
    memcpy(bp,&sin->sin_port,2);
    bp += 2;
    break;
  case AF_INET6:
    optlen = 10;
    *bp++ = type;
    *bp++ = optlen;
    memcpy(bp,&sin6->sin6_addr,8);
    bp += 8;
    memcpy(bp,&sin6->sin6_port,2);
    bp += 2;
    break;
  default:
    return 0;
  }
  *buf = bp;
  return optlen;
}

struct sockaddr *decode_socket(void *sock,uint8_t const *val,int optlen){
  struct sockaddr_in *sin = (struct sockaddr_in *)sock;
  struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)sock;

  if(optlen == 6){
    sin->sin_family = AF_INET;
    memcpy(&sin->sin_addr.s_addr,val,4);
    memcpy(&sin->sin_port,val+4,2);
    return sock;
  } else if(optlen == 10){
    sin6->sin6_family = AF_INET6;
    memcpy(&sin6->sin6_addr,val,8);
    memcpy(&sin6->sin6_port,val+8,2);
    return sock;
  }
  return NULL;
}
