#!/usr/bin/env bash
# Phase 0: prove which AWS services this LocalStack install actually supports
# before any of the architecture depends on them. Creates and deletes one real
# resource per service rather than trusting the published tier list.
set -uo pipefail

ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER=""

aws_() { aws --endpoint-url "$ENDPOINT" "$@"; }

PASS=0
FAIL=0
FAILED_SERVICES=()

# Reports but never fails the run — for services we know are Pro-only and have
# already designed around. Keeps the finding visible instead of buried in docs.
info_check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %s \033[2m(optional)\033[0m\n' "$name"
  else
    printf '  \033[33m-\033[0m %s \033[2m(optional, unsupported on this tier)\033[0m\n' "$name"
  fi
}

check() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    printf '  \033[32m✓\033[0m %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf '  \033[31m✗\033[0m %s\n' "$name"
    printf '      %s\n' "$(echo "$out" | tail -3 | tr '\n' ' ')"
    FAIL=$((FAIL + 1))
    FAILED_SERVICES+=("$name")
  fi
}

echo "LocalStack service coverage check against $ENDPOINT"
echo

if ! curl -sf "$ENDPOINT/_localstack/health" >/dev/null; then
  echo "LocalStack is not reachable at $ENDPOINT. Run: npm run up"
  exit 1
fi

# ---------------------------------------------------------------- identity
check "sts:GetCallerIdentity" \
  aws_ sts get-caller-identity

check "iam:CreateRole/DeleteRole" bash -c "
  aws --endpoint-url $ENDPOINT iam create-role --role-name sdp-smoke \
    --assume-role-policy-document '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}' >/dev/null &&
  aws --endpoint-url $ENDPOINT iam delete-role --role-name sdp-smoke"

# ---------------------------------------------------------------- storage
check "dynamodb:CreateTable/DeleteTable" bash -c "
  aws --endpoint-url $ENDPOINT dynamodb create-table --table-name sdp-smoke \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null &&
  aws --endpoint-url $ENDPOINT dynamodb delete-table --table-name sdp-smoke >/dev/null"

check "s3:CreateBucket/DeleteBucket" bash -c "
  aws --endpoint-url $ENDPOINT s3api create-bucket --bucket sdp-smoke >/dev/null &&
  aws --endpoint-url $ENDPOINT s3api delete-bucket --bucket sdp-smoke"

# ---------------------------------------------------------------- messaging
check "sqs:CreateQueue/DeleteQueue" bash -c "
  url=\$(aws --endpoint-url $ENDPOINT sqs create-queue --queue-name sdp-smoke --query QueueUrl --output text) &&
  aws --endpoint-url $ENDPOINT sqs delete-queue --queue-url \$url"

check "sns:CreateTopic/DeleteTopic" bash -c "
  arn=\$(aws --endpoint-url $ENDPOINT sns create-topic --name sdp-smoke --query TopicArn --output text) &&
  aws --endpoint-url $ENDPOINT sns delete-topic --topic-arn \$arn"

check "events:CreateEventBus/DeleteEventBus" bash -c "
  aws --endpoint-url $ENDPOINT events create-event-bus --name sdp-smoke >/dev/null &&
  aws --endpoint-url $ENDPOINT events delete-event-bus --name sdp-smoke"

# ---------------------------------------------------------------- compute + api
check "lambda:ListFunctions" \
  aws_ lambda list-functions

check "apigateway(v1):CreateRestApi/DeleteRestApi" bash -c "
  id=\$(aws --endpoint-url $ENDPOINT apigateway create-rest-api --name sdp-smoke --query id --output text) &&
  aws --endpoint-url $ENDPOINT apigateway delete-rest-api --rest-api-id \$id"

# Pro-only on the free tier (confirmed 2026-07-27). The whole design uses REST
# v1 because of this — the check stays so a future tier upgrade shows up here.
info_check "apigatewayv2(HTTP):CreateApi" \
  aws_ apigatewayv2 create-api --name sdp-smoke --protocol-type HTTP

# ---------------------------------------------------------------- orchestration
check "stepfunctions:CreateStateMachine/DeleteStateMachine" bash -c "
  arn=\$(aws --endpoint-url $ENDPOINT stepfunctions create-state-machine --name sdp-smoke \
    --role-arn arn:aws:iam::000000000000:role/sdp-smoke \
    --definition '{\"StartAt\":\"P\",\"States\":{\"P\":{\"Type\":\"Pass\",\"End\":true}}}' \
    --query stateMachineArn --output text) &&
  aws --endpoint-url $ENDPOINT stepfunctions delete-state-machine --state-machine-arn \$arn"

# ---------------------------------------------------------------- config + telemetry
check "ssm:PutParameter/DeleteParameter" bash -c "
  aws --endpoint-url $ENDPOINT ssm put-parameter --name /sdp/smoke --value ok --type String --overwrite >/dev/null &&
  aws --endpoint-url $ENDPOINT ssm delete-parameter --name /sdp/smoke"

check "cloudwatch:PutMetricData" \
  aws_ cloudwatch put-metric-data --namespace sdp/smoke --metric-name Smoke --value 1

check "logs:DescribeLogGroups" \
  aws_ logs describe-log-groups

check "cloudformation:ListStacks" \
  aws_ cloudformation list-stacks

echo
echo "  $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "  unsupported: ${FAILED_SERVICES[*]}"
  exit 1
fi
