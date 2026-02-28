{{/*
Expand the name of the chart.
*/}}
{{- define "clonee.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name. Truncated at 63 chars (K8s label limit).
*/}}
{{- define "clonee.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label value.
*/}}
{{- define "clonee.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to all resources.
*/}}
{{- define "clonee.labels" -}}
helm.sh/chart: {{ include "clonee.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Agent Gateway selector labels.
*/}}
{{- define "agentGateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "clonee.name" . }}-agent-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: agent-gateway
{{- end }}

{{/*
Sandbox selector labels.
*/}}
{{- define "sandbox.selectorLabels" -}}
app.kubernetes.io/name: {{ include "clonee.name" . }}-sandbox
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: sandbox
{{- end }}

{{/*
Agent Gateway full name.
*/}}
{{- define "agentGateway.fullname" -}}
{{- printf "%s-agent-gateway" (include "clonee.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Sandbox full name.
*/}}
{{- define "sandbox.fullname" -}}
{{- printf "%s-sandbox" (include "clonee.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Secret name for all sensitive values.
*/}}
{{- define "clonee.secretName" -}}
{{- printf "%s-secrets" (include "clonee.fullname" .) }}
{{- end }}

{{/*
Agent Gateway image reference.
*/}}
{{- define "agentGateway.image" -}}
{{- $repo := .Values.agentGateway.image.repository | default (printf "%s/clonee-agent-gateway" .Values.global.imageRegistry) }}
{{- printf "%s:%s" $repo (.Values.agentGateway.image.tag | default "latest") }}
{{- end }}

{{/*
Sandbox image reference.
*/}}
{{- define "sandbox.image" -}}
{{- $repo := .Values.sandbox.image.repository | default (printf "%s/clonee-sandbox" .Values.global.imageRegistry) }}
{{- printf "%s:%s" $repo (.Values.sandbox.image.tag | default "latest") }}
{{- end }}

{{/*
Namespace helper — uses global override or falls back to release namespace.
*/}}
{{- define "clonee.namespace" -}}
{{- .Values.global.namespace | default .Release.Namespace }}
{{- end }}

{{/*
Sandbox internal service URL (for agent-gateway to call).
*/}}
{{- define "sandbox.internalUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "sandbox.fullname" .) (include "clonee.namespace" .) (.Values.sandbox.service.port | int) }}
{{- end }}
