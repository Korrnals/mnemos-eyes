# Патч NetworkPolicy `agentsnode-policies`: доступ traefik к подам agentsnode

- Статус: **готов к deploy-окну** (SRE-1 / SEC-3 AMEND)
- Дата подготовки: 2026-09-16; все цитаты — из живого кластера (контекст
  `abyss-ai-agent`, чтение), проверены в тот же день
- Связано: ADR-0004 §5 (root cause 502), `deploy/chart/vesmaro-eyes/RUNBOOK.md`
- Патч-файл: `deploy/k8s/netpol-traefik-fix-patch.yaml`

## 1. Что происходит

Общая для всего namespaces-лейбла `part-of=agentsnode` NetworkPolicy
`agentsnode-policies` (namespace `kube-agents`, **чужой** helm-чарт
`agentsnode-policies-0.1.8`, release revision 13) разрешает ingress к подам
только из:

1. своего namespace (`podSelector: {}`) — порты 8642, 9119, 20128, **8787**,
   6080, 5900, 1080, **8080**;
2. LAN `192.168.1.0/24` — порты 8642, 9119, 20128, 8787, 6080 (**без 8080**).

traefik (namespace `kube-system`, pod-IP 10.42.x) под оба правила не попадает
→ REJECT на pod-IP/ClusterIP бэкенды → 502. Доказательная матрица — ADR-0004 §5.

Целевой фикс: добавить в `spec.ingress` правило «from kube-system /
`app.kubernetes.io/name=traefik`». Лейблы traefik-пода сверены с кластером:

```
app.kubernetes.io/instance=traefik-kube-system
app.kubernetes.io/managed-by=Helm
app.kubernetes.io/name=traefik
helm.sh/chart=traefik-39.0.701_up39.0.7
```

helm-релиз `traefik` (chart traefik-39.0.701+up39.0.7) живёт в `kube-system`;
селектор namespace — по автолейблу `kubernetes.io/metadata.name=kube-system`
(присутствует, проверено).

## 2. Почему патч, а не helm override, и чем это грозит

Релиз управляется **чужим** чартом из другого репозитория; его values-схема
нам не принадлежит, `helm upgrade` с чужим чартом из этого репо невозможен и
не нужен. Поэтому — `kubectl patch` (`--type=json`, атомарный append в
`/spec/ingress/-`; список заменяется целиком только при strategic-патче, JSON
patch этого риска не несёт).

**Критичное предупреждение:** ресурс принадлежит helm-релизу
`agentsnode-policies` (revision 13). Любой следующий `helm upgrade
agentsnode-policies` или `helm rollback` **тихо откатит** это правило.
Обязательные компенсации:

1. Провести изменение в источник чарта `agentsnode-policies` (его репозиторий,
   values → ingress-порты для traefik) — тогда следующий upgrade чарта
   включает правило штатно.
2. До этого момента — после КАЖДОГО `helm upgrade agentsnode-policies`
   проверять наличие правила и пере-применять патч (команда ниже); внести
   этот шаг в чек-лист владельца чарта.

## 3. Применение (deploy-окно)

Порядок относительно миграции борда — строго **до** `helm install`
(иначе окно 502): netpol-патч → adoption → helm install → проверка.

```bash
# 0. Бэкап текущего состояния (обязательный шаг, путь к rollback)
kubectl get networkpolicy agentsnode-policies -n kube-agents -o yaml \
  > deploy/k8s/backup-netpol-$(date +%Y%m%d-%H%M).yaml

# 1. Патч (JSON patch, append)
kubectl patch networkpolicy agentsnode-policies -n kube-agents \
  --type=json --patch-file deploy/k8s/netpol-traefik-fix-patch.yaml

# 2. Проверка: правило появилось третьим в spec.ingress
kubectl get networkpolicy agentsnode-policies -n kube-agents -o jsonpath='{range .spec.ingress[*]}{.from}{" -> "}{.ports[*].port}{"\n"}{end}'
```

## 4. Rollback

Вариант А (точечный, рекомендованный) — вернуть исходные два правила
(strategic-патч заменяет список `ingress` целиком):

```bash
kubectl patch networkpolicy agentsnode-policies -n kube-agents --type=strategic -p '
spec:
  ingress:
    - from:
        - podSelector: {}
      ports:
        - port: 8642
          protocol: TCP
        - port: 9119
          protocol: TCP
        - port: 20128
          protocol: TCP
        - port: 8787
          protocol: TCP
        - port: 6080
          protocol: TCP
        - port: 5900
          protocol: TCP
        - port: 1080
          protocol: TCP
        - port: 8080
          protocol: TCP
    - from:
        - ipBlock:
            cidr: 192.168.1.0/24
      ports:
        - port: 8642
          protocol: TCP
        - port: 9119
          protocol: TCP
        - port: 20128
          protocol: TCP
        - port: 8787
          protocol: TCP
        - port: 6080
          protocol: TCP
'
```

(Содержимое — точная копия исходных правил из живого YAML на 2026-09-16.)

Вариант Б (аварийный, грубый): `helm rollback agentsnode-policies 13 -n
kube-agents` — откатывает ВЕСЬ релиз на revision 13, а не только netpol;
применять только если А недоступен.

## 5. Последствия — осознанные и задокументированные

- **mnemos-ingress станет доступен.** Порт 8787 в правиле — сознательное
  восстановление задуманного поведения: ingress `agentsnode-mnemos-ingress`
  (`mnemos.abyss.lab`, класс traefik) существует 50 дней и сейчас 502 по той
  же причине. После патча `https://mnemos.abyss.lab` (и борд, и mnemos) начнёт
  ходить трафик через traefik — это ожидаемо, не инцидент.
- Порты 20128 (omniroute), 5900/6080 (hermes-desktop), 8642/9119 (hermes) в
  правило **не** включены намеренно (minimal privilege): их ingress-пути
  работают иным образом (omniroute — без лейбла, desktop — hostNetwork) либо
  целевой сервис сейчас не в строю (hermes: 0/1 Unknown). Расширение списка —
  отдельное решение с записью в этом файле.
- **Рекомендация (не в этом окне):** включить accesslog traefik для
  наблюдаемости нового ingress-пути:
  `helm upgrade traefik traefik/traefik -n kube-system --reuse-values --set "additionalArguments={--accesslog=true}"`.
  Мутация kube-system — отдельное решение оркестратора.

## 6. Связанная политика борда

Собственный netpol борда (`vesmaro-eyes-netpol` из чарта) работает В ПАРЕ с
этим: netpol-семантика — объединение всех политик, выбирающих под. Обе
политики одновременно разрешают traefik → 8080, поэтомуunion стабилен; при
откате этого патча traefik-путь к борду умрёт, даже если собственная политика
чарта останется — **откатывать патч отдельно от отката борда нельзя**.
