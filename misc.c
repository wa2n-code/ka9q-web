/* Minimal misc.c providing a few helpers required by ka9q-web build.
   These are small adaptations of upstream ka9q-radio functions. */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#include "conf.h"
#include "misc.h"
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
#include <time.h>

/* Simple sincospif implementation using sincosf with M_PI factor */
void sincospif(float x, float *s, float *c){
  sincosf(x * M_PIf, s, c);
}

/* Mirror allocator/free wrappers. Use mmap to create mirrored region on Linux; fallback to malloc. */
void *mirror_alloc(size_t size){
#ifdef __linux__
  size_t pagesize = (size_t) getpagesize();
  size = ((size + pagesize - 1) / pagesize) * pagesize;
  int fd = memfd_create("mirror_alloc", 0);
  if(fd >= 0){
    if(ftruncate(fd, (off_t)size) == 0){
      void *base = mmap(NULL, size * 2, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
      if(base == MAP_FAILED) {
        close(fd);
        return NULL;
      }
      void *a = mmap(base, size, PROT_READ | PROT_WRITE, MAP_FIXED | MAP_SHARED, fd, 0);
      if(a == MAP_FAILED){
        munmap(base, size * 2);
        close(fd);
        return NULL;
      }
      void *b = mmap((char*)base + size, size, PROT_READ | PROT_WRITE, MAP_FIXED | MAP_SHARED, fd, 0);
      if(b == MAP_FAILED){
        munmap(base, size * 2);
        close(fd);
        return NULL;
      }
      close(fd);
      return base;
    }
    close(fd);
  }
  /* Fallback */
  (void)size;
  return malloc(size);
#else
  return malloc(size);
#endif
}

void mirror_free(void **p,size_t size){
  if(p == NULL || *p == NULL)
    return;
#ifdef __linux__
  munmap(*p, size * 2);
  *p = NULL;
#else
  free(*p);
  *p = NULL;
#endif
}

/* gps_time_ns: high-resolution timestamp in nanoseconds since epoch */
long long gps_time_ns(void){
  struct timespec ts;
  if(clock_gettime(CLOCK_REALTIME,&ts) != 0)
    return 0;
  return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

// FNV-1 hash (https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function)
uint32_t fnv1hash(const uint8_t *s,int length){
  uint32_t hash = 0x811c9dc5;
  while(length-- > 0){
    hash *= 0x01000193;
    hash ^= *s++;
  }
  return hash;
}
