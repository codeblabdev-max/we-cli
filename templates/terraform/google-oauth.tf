# Google OAuth 설정 Terraform 템플릿
# 이 파일은 Google Cloud OAuth 클라이언트와 redirect URI를 관리합니다.
#
# 사용법:
# 1. 변수 파일 생성: terraform.tfvars
# 2. terraform init
# 3. terraform plan
# 4. terraform apply

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  # 선택사항: 원격 상태 저장소
  # backend "gcs" {
  #   bucket = "your-terraform-state-bucket"
  #   prefix = "oauth"
  # }
}

# 변수 정의
variable "project_id" {
  description = "Google Cloud 프로젝트 ID"
  type        = string
}

variable "project_number" {
  description = "Google Cloud 프로젝트 번호"
  type        = string
}

variable "brand_id" {
  description = "OAuth 브랜드 ID"
  type        = string
}

variable "app_name" {
  description = "애플리케이션 이름"
  type        = string
  default     = "CodeB CMS"
}

variable "base_domain" {
  description = "기본 도메인"
  type        = string
  default     = "codeb.dev"
}

variable "environments" {
  description = "환경별 서브도메인 설정"
  type = map(object({
    subdomain    = string
    callback_path = string
  }))
  default = {
    local = {
      subdomain     = "localhost:3000"
      callback_path = "/api/auth/callback/google"
    }
    staging = {
      subdomain     = "staging"
      callback_path = "/api/auth/callback/google"
    }
    production = {
      subdomain     = "app"
      callback_path = "/api/auth/callback/google"
    }
  }
}

# Provider 설정
provider "google" {
  project = var.project_id
  region  = "asia-northeast3"
}

# OAuth 2.0 API 활성화
resource "google_project_service" "oauth2" {
  service = "oauth2.googleapis.com"
  disable_on_destroy = false
}

# IAP API 활성화
resource "google_project_service" "iap" {
  service = "iap.googleapis.com"
  disable_on_destroy = false
}

# OAuth Consent Screen (브랜드)
# 주의: 이미 존재하는 경우 import 필요
# terraform import google_iap_brand.main projects/PROJECT_NUMBER/brands/BRAND_ID
resource "google_iap_brand" "main" {
  support_email     = "support@${var.base_domain}"
  application_title = var.app_name
  project           = var.project_number
}

# OAuth 클라이언트
resource "google_iap_client" "web_client" {
  display_name = "${var.app_name} Web Client"
  brand        = google_iap_brand.main.name
}

# Redirect URI 동적 생성
locals {
  redirect_uris = flatten([
    for env_key, env in var.environments : [
      env_key == "local"
        ? "http://${env.subdomain}${env.callback_path}"
        : "https://${env.subdomain}.${var.base_domain}${env.callback_path}"
    ]
  ])
}

# 출력값
output "client_id" {
  description = "OAuth 클라이언트 ID"
  value       = google_iap_client.web_client.client_id
  sensitive   = true
}

output "client_secret" {
  description = "OAuth 클라이언트 시크릿"
  value       = google_iap_client.web_client.secret
  sensitive   = true
}

output "redirect_uris" {
  description = "설정된 Redirect URIs"
  value       = local.redirect_uris
}

output "oauth_consent_screen" {
  description = "OAuth 동의 화면 URL"
  value       = "https://console.cloud.google.com/apis/credentials/consent?project=${var.project_id}"
}
