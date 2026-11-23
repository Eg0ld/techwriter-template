# Sourced by a workflow step that pushes or fetches. The token stays in that
# step's environment and is never written to .git/config.
: "${GH_TOKEN:?GH_TOKEN is required}"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
export GIT_CONFIG_VALUE_0
