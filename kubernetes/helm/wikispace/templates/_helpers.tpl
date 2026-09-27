{{/* ===========================================================================
  _helpers.tpl — общие куски шаблонов: имена, метки, адреса базы данных
=========================================================================== */}}

{{/* Полное имя релиза (префикс всех ресурсов). */}}
{{- define "wikispace.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Общие метки всех ресурсов. */}}
{{- define "wikispace.labels" -}}
app.kubernetes.io/name: {{ default .Chart.Name .Values.nameOverride }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Метки-селектор блока web (не менять после установки). */}}
{{- define "wikispace.webSelector" -}}
app.kubernetes.io/name: {{ default .Chart.Name .Values.nameOverride }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end -}}

{{/* Имена ресурсов блоков. */}}
{{- define "wikispace.web" -}}{{ include "wikispace.fullname" . }}-web{{- end -}}
{{- define "wikispace.db" -}}{{ include "wikispace.fullname" . }}-db{{- end -}}
{{- define "wikispace.secret" -}}{{ default (printf "%s-app" (include "wikispace.fullname" .)) .Values.app.existingSecret }}{{- end -}}

{{/* Secret с учётными данными PostgreSQL (ключи username / password). */}}
{{- define "wikispace.dbSecret" -}}
{{- if eq .Values.postgresql.mode "cnpg" -}}
{{ include "wikispace.db" . }}-app
{{- else -}}
{{ include "wikispace.db" . }}-auth
{{- end -}}
{{- end -}}

{{/* Хост для ЗАПИСИ, к которому подключаются копии web (через PgBouncer). */}}
{{- define "wikispace.dbHost" -}}
{{- if eq .Values.postgresql.mode "cnpg" -}}
{{- if .Values.postgresql.pooler.enabled -}}{{ include "wikispace.db" . }}-pooler-rw{{- else -}}{{ include "wikispace.db" . }}-rw{{- end -}}
{{- else -}}
{{ include "wikispace.db" . }}
{{- end -}}
{{- end -}}

{{/* Хост напрямую к основному серверу — для миграций (advisory-блокировки
     через PgBouncer в режиме транзакций не работают). */}}
{{- define "wikispace.dbDirectHost" -}}
{{- if eq .Values.postgresql.mode "cnpg" -}}{{ include "wikispace.db" . }}-rw{{- else -}}{{ include "wikispace.db" . }}{{- end -}}
{{- end -}}

{{/* Хост реплик для чтения (поиск) или пусто. */}}
{{- define "wikispace.dbReadHost" -}}
{{- if and (eq .Values.postgresql.mode "cnpg") (gt (int .Values.postgresql.cnpg.instances) 1) .Values.postgresql.pooler.readReplicas -}}
{{- if .Values.postgresql.pooler.enabled -}}{{ include "wikispace.db" . }}-pooler-ro{{- else -}}{{ include "wikispace.db" . }}-ro{{- end -}}
{{- end -}}
{{- end -}}

{{/* Переменные подключения к БД. $direct = true — напрямую к основному
     серверу (init-контейнер), иначе — через пулер (основной контейнер).
     Пароли CloudNativePG и чарта — буквы и цифры, их можно вставлять в URL. */}}
{{- define "wikispace.dbEnv" -}}
{{- $root := .root -}}
{{- if eq $root.Values.postgresql.mode "external" }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.postgresql.external.existingSecret }}
      key: {{ ternary "DATABASE_DIRECT_URL" "DATABASE_URL" .direct }}
{{- if not .direct }}
- name: DATABASE_READ_URL
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.postgresql.external.existingSecret }}
      key: DATABASE_READ_URL
      optional: true
{{- end }}
{{- else }}
- name: PGHOST
  value: {{ ternary (include "wikispace.dbDirectHost" $root) (include "wikispace.dbHost" $root) .direct | quote }}
- name: PGPORT
  value: "5432"
- name: PGDATABASE
  value: {{ $root.Values.postgresql.database | quote }}
- name: PGUSER
  valueFrom:
    secretKeyRef:
      name: {{ include "wikispace.dbSecret" $root }}
      key: username
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "wikispace.dbSecret" $root }}
      key: password
{{- $readHost := include "wikispace.dbReadHost" $root }}
{{- if and (not .direct) $readHost }}
- name: DATABASE_READ_URL
  value: "postgresql://$(PGUSER):$(PGPASSWORD)@{{ $readHost }}:5432/{{ $root.Values.postgresql.database }}"
{{- end }}
{{- end }}
{{- end -}}
