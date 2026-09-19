{{/* vim: set filetype=mustache: */}}

{{/* Chart-provided name (short) */}}
{{- define "vesmaro-eyes.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name: release name by contract (must stay
"vesmaro-eyes" so pre-existing bare resources are adopted, see RUNBOOK). */}}
{{- define "vesmaro-eyes.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/* Common labels. part-of=agentsnode is REQUIRED: the foreign shared
NetworkPolicy agentsnode-policies selects it and the board needs the
same-namespace rules to reach agentsnode-mnemos. */}}
{{- define "vesmaro-eyes.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "vesmaro-eyes.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: agentsnode
{{- with .Values.podLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Selector labels — immutable part of the Deployment selector. */}}
{{- define "vesmaro-eyes.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vesmaro-eyes.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: board
{{- end }}

{{/* ServiceAccount name */}}
{{- define "vesmaro-eyes.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "vesmaro-eyes.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Board-token secret name: externally managed or chart-generated. */}}
{{- define "vesmaro-eyes.boardTokenSecretName" -}}
{{- default (printf "%s-board-token" (include "vesmaro-eyes.fullname" .)) .Values.boardToken.existingSecret }}
{{- end }}

{{/* UI-token secret name (ADR 0009 §2 A1): externally managed or
chart-generated. Same pattern as the board token. */}}
{{- define "vesmaro-eyes.uiTokenSecretName" -}}
{{- default (printf "%s-ui-token" (include "vesmaro-eyes.fullname" .)) .Values.uiToken.existingSecret }}
{{- end }}

{{/* PVC claim name */}}
{{- define "vesmaro-eyes.pvcName" -}}
{{- default (printf "%s-data" (include "vesmaro-eyes.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{/* Image with tag fallback to appVersion */}}
{{- define "vesmaro-eyes.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end }}
