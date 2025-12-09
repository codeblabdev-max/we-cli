#!/bin/bash
# Google OAuth Redirect URI 업데이트 스크립트
#
# 사용법:
#   ./update-google-oauth.sh [환경] [도메인]
#   ./update-google-oauth.sh preview pr-123.myapp.codeb.dev
#   ./update-google-oauth.sh staging staging.codeb.dev
#   ./update-google-oauth.sh production app.codeb.dev
#
# 환경변수:
#   GOOGLE_PROJECT_ID - Google Cloud 프로젝트 ID
#   GOOGLE_CLIENT_ID  - OAuth 클라이언트 ID

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 함수: 로그 출력
log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# 인자 파싱
ENVIRONMENT=${1:-"preview"}
DOMAIN=${2:-""}
CALLBACK_PATH=${3:-"/api/auth/callback/google"}

# 환경변수 확인
if [ -z "$GOOGLE_PROJECT_ID" ]; then
  log_error "GOOGLE_PROJECT_ID 환경변수가 설정되지 않았습니다."
  echo "  export GOOGLE_PROJECT_ID='your-project-id'"
  exit 1
fi

if [ -z "$GOOGLE_CLIENT_ID" ]; then
  log_error "GOOGLE_CLIENT_ID 환경변수가 설정되지 않았습니다."
  echo "  export GOOGLE_CLIENT_ID='your-client-id.apps.googleusercontent.com'"
  exit 1
fi

# gcloud 확인
if ! command -v gcloud &> /dev/null; then
  log_error "gcloud CLI가 설치되어 있지 않습니다."
  echo ""
  echo "설치 방법:"
  echo "  macOS:   brew install google-cloud-sdk"
  echo "  Linux:   curl https://sdk.cloud.google.com | bash"
  echo "  Windows: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# 인증 확인
if ! gcloud auth print-access-token &> /dev/null; then
  log_warning "Google Cloud 인증이 필요합니다."
  gcloud auth login
fi

log_info "Google OAuth Redirect URI 업데이트"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "프로젝트: $GOOGLE_PROJECT_ID"
echo "클라이언트: $GOOGLE_CLIENT_ID"
echo "환경: $ENVIRONMENT"
echo "도메인: $DOMAIN"
echo ""

# Access Token 획득
TOKEN=$(gcloud auth print-access-token)

# 현재 설정된 redirect URI 조회
log_info "현재 Redirect URI 조회 중..."

CURRENT_URIS=$(curl -s \
  "https://www.googleapis.com/oauth2/v1/projects/${GOOGLE_PROJECT_ID}/oauthClients/${GOOGLE_CLIENT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq -r '.redirectUris[]' 2>/dev/null || echo "")

if [ -n "$CURRENT_URIS" ]; then
  echo "현재 설정된 URI:"
  echo "$CURRENT_URIS" | while read uri; do
    echo "  - $uri"
  done
else
  log_warning "현재 설정된 URI를 조회할 수 없거나 비어있습니다."
fi

# 새 URI 구성
if [ -n "$DOMAIN" ]; then
  if [[ "$DOMAIN" == "localhost"* ]]; then
    NEW_URI="http://${DOMAIN}${CALLBACK_PATH}"
  else
    NEW_URI="https://${DOMAIN}${CALLBACK_PATH}"
  fi

  log_info "새 Redirect URI 추가: $NEW_URI"

  # 기존 URI에 새 URI 추가
  ALL_URIS=$(echo "$CURRENT_URIS" | jq -R . | jq -s .)
  NEW_URIS=$(echo "$ALL_URIS" | jq --arg new "$NEW_URI" '. + [$new] | unique')

  # API 호출로 업데이트
  log_info "OAuth 클라이언트 업데이트 중..."

  RESPONSE=$(curl -s -X PATCH \
    "https://www.googleapis.com/oauth2/v1/projects/${GOOGLE_PROJECT_ID}/oauthClients/${GOOGLE_CLIENT_ID}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"redirectUris\": ${NEW_URIS}}")

  if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message')
    log_error "업데이트 실패: $ERROR_MSG"
    echo ""
    log_warning "대안: Google Cloud Console에서 수동으로 추가하세요."
    echo "  URL: https://console.cloud.google.com/apis/credentials?project=${GOOGLE_PROJECT_ID}"
    echo "  추가할 URI: $NEW_URI"
    exit 1
  else
    log_success "Redirect URI 업데이트 완료!"
    echo ""
    echo "추가된 URI: $NEW_URI"
  fi
else
  # URI 목록만 표시
  echo ""
  log_info "기본 환경별 Redirect URI 권장 설정:"
  echo ""
  echo "  Local:      http://localhost:3000${CALLBACK_PATH}"
  echo "  Staging:    https://staging.codeb.dev${CALLBACK_PATH}"
  echo "  Production: https://app.codeb.dev${CALLBACK_PATH}"
  echo "  Preview:    https://pr-*.preview.codeb.dev${CALLBACK_PATH}"
  echo ""
  log_info "특정 도메인 추가:"
  echo "  ./update-google-oauth.sh preview pr-123.myapp.codeb.dev"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "OAuth 콘솔: https://console.cloud.google.com/apis/credentials?project=${GOOGLE_PROJECT_ID}"
