# M1a tree-sitter spike report

Generated: 2026-08-12T23:22:43.912Z

Scanned roots: `/Users/ahmedelbannan/Ahmed/xenoblade/src/kyoshin`, `/Users/ahmedelbannan/Ahmed/xenoblade/libs/monolib/src`, `/Users/ahmedelbannan/Ahmed/xenoblade/libs/nw4r/src`

## Summary

| metric | value |
| --- | --- |
| files scanned | 1692 |
| files with error nodes (`root.hasError`) | 768 (45.4%) |
| parse exceptions | 0 |
| total nodes (all files, `descendantCount`) | 136255708 |
| total error-node matches | 1612045 |
| error-node rate (per 1k nodes) | 11.83 |
| error-node rate (per file) | 952.75 |

## Top 20 offenders

Sorted by error-node count (desc), then size (desc), then path.

| file | errors | size (bytes) |
| --- | ---: | ---: |
| ../xenoblade/libs/nw4r/src/snd/snd_Voice.ctx.c | 8851 | 8957391 |
| ../xenoblade/src/kyoshin/cf/CfSoundMan.ctx.c | 8751 | 9078498 |
| ../xenoblade/libs/nw4r/src/snd/snd_StrmPlayer.ctx.c | 8750 | 8974576 |
| ../xenoblade/src/kyoshin/cf/chain/CChain.ctx.c | 8691 | 9442489 |
| ../xenoblade/src/kyoshin/cf/CBattleManager.ctx.c | 8658 | 9656737 |
| ../xenoblade/libs/nw4r/src/snd/snd_SoundArchivePlayer.ctx.c | 8656 | 8948781 |
| ../xenoblade/libs/nw4r/src/snd/snd_MmlParser.ctx.c | 8620 | 8954045 |
| ../xenoblade/libs/nw4r/src/snd/snd_AxVoice.ctx.c | 8447 | 8943992 |
| ../xenoblade/libs/nw4r/src/snd/snd_RemoteSpeaker.ctx.c | 8440 | 8944950 |
| ../xenoblade/libs/nw4r/src/snd/snd_AxManager.ctx.c | 8427 | 8946167 |
| ../xenoblade/libs/nw4r/src/snd/snd_SoundSystem.ctx.c | 8387 | 8941356 |
| ../xenoblade/libs/nw4r/src/snd/snd_RemoteSpeakerManager.ctx.c | 8387 | 8937613 |
| ../xenoblade/libs/nw4r/src/snd/snd_SeqPlayer.ctx.c | 8380 | 8931357 |
| ../xenoblade/libs/nw4r/src/snd/snd_BasicSound.ctx.c | 8352 | 8932640 |
| ../xenoblade/libs/nw4r/src/snd/snd_WsdPlayer.ctx.c | 8340 | 8927836 |
| ../xenoblade/libs/nw4r/src/snd/snd_SoundArchiveFile.ctx.c | 8332 | 8925491 |
| ../xenoblade/libs/nw4r/src/snd/snd_AxVoiceManager.ctx.c | 8330 | 8925129 |
| ../xenoblade/libs/nw4r/src/snd/snd_SeqTrack.ctx.c | 8319 | 8921616 |
| ../xenoblade/libs/nw4r/src/snd/snd_Channel.ctx.c | 8313 | 8932636 |
| ../xenoblade/libs/nw4r/src/snd/snd_WaveFile.ctx.c | 8313 | 8930554 |

## Error-node samples

First samples from the worst offenders (`line:col` of the first error node per file, snippet truncated to 100 chars).

### ../xenoblade/libs/nw4r/src/snd/snd_Voice.ctx.c

- `1:1` — `/* "libs/nw4r/src/snd/snd_Voice.cpp" line 0 "nw4r/snd.h" */ #ifndef NW4R_PUBLIC_SND_H #define NW4R_P`
- `48:1` — `}`
- `93:1` — `}`
- `135:1` — `}`
- `844:18` — `CharStrmReader::`

### ../xenoblade/src/kyoshin/cf/CfSoundMan.ctx.c

- `1:1` — `/* "src/kyoshin/cf/CfSoundMan.cpp" line 0 "kyoshin/cf/CfSoundMan.hpp" */ #pragma once /* "src/kyoshi`
- `41:1` — `}`
- `86:1` — `}`
- `128:1` — `}`
- `849:18` — `CharStrmReader::`

### ../xenoblade/libs/nw4r/src/snd/snd_StrmPlayer.ctx.c

- `1:1` — `/* "libs/nw4r/src/snd/snd_StrmPlayer.cpp" line 0 "nw4r/snd.h" */ #ifndef NW4R_PUBLIC_SND_H #define N`
- `48:1` — `}`
- `93:1` — `}`
- `135:1` — `}`
- `844:18` — `CharStrmReader::`

### ../xenoblade/src/kyoshin/cf/chain/CChain.ctx.c

- `1:1` — `/* "src/kyoshin/cf/chain/CChain.cpp" line 0 "kyoshin/cf/chain/CChain.hpp" */ #pragma once /* "src/ky`
- `41:1` — `}`
- `86:1` — `}`
- `128:1` — `}`
- `743:1` — `}`

### ../xenoblade/src/kyoshin/cf/CBattleManager.ctx.c

- `1:1` — `/* "src/kyoshin/cf/CBattleManager.cpp" line 0 "kyoshin/cf/CBattleManager.hpp" */ #pragma once /* "sr`
- `41:1` — `}`
- `86:1` — `}`
- `128:1` — `}`
- `1578:1` — `}`
