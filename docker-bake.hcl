# =============================================================================
#  docker-bake.hcl — декларативная мультиплатформенная сборка (docker buildx bake)
# =============================================================================
#  Собрать и опубликовать образ сразу для нескольких архитектур:
#
#     docker buildx bake --push
#     IMAGE=ghcr.io/me/wikispace TAG=1.0.0 docker buildx bake --push
#
#  Собрать только для текущей машины и загрузить в локальный Docker:
#
#     docker buildx bake local
#
#  Для сборки под «чужие» архитектуры нужен builder с поддержкой нескольких
#  платформ. В Docker Desktop он есть «из коробки»; на Linux один раз:
#     docker run --privileged --rm tonistiigi/binfmt --install all
#     docker buildx create --use --name multi
# =============================================================================

variable "IMAGE" {
  default = "wikispace"
}

variable "TAG" {
  default = "latest"
}

variable "NODE_VERSION" {
  default = "22"
}

# Общие параметры для всех целей.
target "_common" {
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    NODE_VERSION = NODE_VERSION
  }
}

# Цель по умолчанию: все поддерживаемые платформы.
#   linux/amd64  — обычные серверы и ПК (Intel/AMD)
#   linux/arm64  — Apple Silicon, AWS Graviton, Raspberry Pi 4/5 (64-бит ОС)
#   linux/arm/v7 — Raspberry Pi 2/3 и другие 32-битные ARM-платы
target "default" {
  inherits  = ["_common"]
  platforms = ["linux/amd64", "linux/arm64", "linux/arm/v7"]
  tags      = ["${IMAGE}:${TAG}"]
}

# Локальная сборка для текущей архитектуры (результат — в `docker images`).
target "local" {
  inherits = ["_common"]
  tags     = ["${IMAGE}:${TAG}"]
  output   = ["type=docker"]
}
