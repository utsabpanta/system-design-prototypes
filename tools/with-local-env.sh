#!/usr/bin/env bash
# Runs a command pointed at LocalStack.
#
# Everything local goes through here so exactly one file knows the endpoint and
# the dummy credentials. Drop this wrapper and the same commands target real AWS.
set -euo pipefail

export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
# cdklocal insists on an explicit S3 endpoint whenever AWS_ENDPOINT_URL is set;
# the virtual-host form is what LocalStack wants for bucket addressing.
export AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-http://s3.localhost.localstack.cloud:4566}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-000000000000}"
export CDK_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""

exec "$@"
