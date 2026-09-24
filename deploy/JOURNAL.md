# vesmaro-eyes deploy JOURNAL — append-only audit trail (AGW-10)
# date | actor | action | helm rev before>after | image tag | chart version | HEAD
2026-09-24T00:49:02+0300 | abyss@core-51 | deploy | rev 67>68 | image 1.33.0 | chart 1.33.0 | HEAD ccdd864 | allow-drift: release bump 1.32.0->1.33.0: live несёт прошлый image.tag — единственный не-секретный дрейф (штатный релизный путь, см. AGW-10)
2026-09-24T02:01:10+0300 | gcw-git-workflow-specialist@release-1.34.0 | deploy | rev 68>69 | image 1.34.0 | chart 1.34.0 | HEAD 62053dd | auto-waived: image.tag drift = previous release (deployed-revision appVersion)
2026-09-24T02:17:28+0300 | abyss@core-51 | deploy | rev 69>70 | image 1.35.0 | chart 1.35.0 | HEAD 15b20bf | auto-waived: image.tag drift = previous release (deployed-revision appVersion)
2026-09-24T03:41:48+0300 | abyss@core-51 | deploy | rev 70>71 | image 1.36.0 | chart 1.36.0 | HEAD ccbc534 | auto-waived: image.tag drift = previous release (deployed-revision appVersion)
2026-09-25T00:19:11+0300 | abyss@core-51 | deploy | rev 71>72 | image 1.37.0 | chart 1.37.0 | HEAD 63ad22b | auto-waived: image.tag drift = previous release (deployed-revision appVersion)
2026-09-25T00:44:46+0300 | abyss@core-51 | deploy | rev 72>73 | image 1.37.1 | chart 1.37.1 | HEAD d079ea6 | auto-waived: image.tag drift = previous release (deployed-revision appVersion)
