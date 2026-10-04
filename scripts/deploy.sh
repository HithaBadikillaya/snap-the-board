#!/usr/bin/env bash
# Deploys (or updates) the whole backend. Run from the project root:
#   bash scripts/deploy.sh
# Optional settings, set before running:
#   SITE_URL=https://yourname.github.io/snap-the-board   (link used inside emails)
#   DAILY_LIMIT=30                                       (photos read per day)
#   MODEL_ID=...                                         (required outside ap-south-1)
set -euo pipefail

STACK="snap-the-board"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
DAILY_LIMIT="${DAILY_LIMIT:-30}"
SITE_URL="${SITE_URL:-}"

if [[ "$REGION" != "ap-south-1" && -z "${MODEL_ID:-}" ]]; then
  echo "Your region is $REGION. This script defaults to Mumbai (ap-south-1)." >&2
  echo "Either switch to Mumbai, or export MODEL_ID for your region first." >&2
  exit 1
fi
MODEL_ID="${MODEL_ID:-apac.amazon.nova-lite-v1:0}"

if [[ -z "${TEACHER_PASSCODE:-}" ]]; then
  read -rsp "Choose a teacher passcode (10+ characters, no spaces at the ends): " TEACHER_PASSCODE
  echo
fi
if [[ ${#TEACHER_PASSCODE} -lt 10 || ! "$TEACHER_PASSCODE" =~ ^[[:print:]]+$ \
      || "$TEACHER_PASSCODE" == " "* || "$TEACHER_PASSCODE" == *" " ]]; then
  echo "Passcode must be 10+ plain keyboard characters with no space at either end." >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  HASH="$(printf '%s' "$TEACHER_PASSCODE" | sha256sum | cut -d' ' -f1)"
else
  HASH="$(printf '%s' "$TEACHER_PASSCODE" | shasum -a 256 | cut -d' ' -f1)"
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ARTIFACTS="snap-board-artifacts-${ACCOUNT}-${REGION}"
echo "Account $ACCOUNT, region $REGION, model $MODEL_ID, daily limit $DAILY_LIMIT"

# A first attempt that failed leaves a stack that cannot be updated. Clear it.
STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
if [[ "$STATUS" == "ROLLBACK_COMPLETE" ]]; then
  echo "Removing the failed earlier attempt..."
  aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"
fi

if ! aws s3api head-bucket --bucket "$ARTIFACTS" 2>/dev/null; then
  aws s3 mb "s3://${ARTIFACTS}" --region "$REGION"
fi

aws cloudformation package \
  --template-file template.yaml \
  --s3-bucket "$ARTIFACTS" \
  --output-template-file /tmp/snap-packaged.yaml \
  --region "$REGION"

aws cloudformation deploy \
  --template-file /tmp/snap-packaged.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    ModelId="$MODEL_ID" \
    TeacherKeyHash="$HASH" \
    SiteUrl="$SITE_URL" \
    DailyLimit="$DAILY_LIMIT"

API_URL="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"
echo
echo "Deployed."
echo "API URL (paste into frontend/config.js): $API_URL"
