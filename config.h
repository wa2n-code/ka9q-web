#ifndef CONFIG_H
#define CONFIG_H

/* Minimal config.h to satisfy ka9q-web.c build in this repo.
   If your real project defines RESOURCES_BASE_DIR or other build-time
   macros differently, update this file accordingly. */

#ifndef RESOURCES_BASE_DIR
#define RESOURCES_BASE_DIR "/usr/local/share/ka9q-web"
#endif

#endif /* CONFIG_H */
