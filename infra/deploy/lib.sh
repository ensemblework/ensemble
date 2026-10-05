# shellcheck shell=bash
# Shared helpers for the Ensemble VM scripts. Sourced, not executed.
# These functions never print env values.

load_env_file() {
  local file="$1"
  local line trimmed key value
  if [ ! -f "$file" ]; then
    echo "Env file not found: $file" >&2
    echo "Copy infra/deploy/ensemble.env.example to /etc/ensemble.env (mode 0600) and fill it in. This script only fills in REDIS_URL there (local Redis, blank or placeholder value)." >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      '' | \#*) continue ;;
    esac
    trimmed="${trimmed#export }"
    key="${trimmed%%=*}"
    if [ "$key" = "$trimmed" ]; then
      echo "Ignoring an env line that is not KEY=VALUE. The line was not printed." >&2
      continue
    fi
    case "$key" in
      [A-Za-z_][A-Za-z0-9_]*) ;;
      *)
        echo "Ignoring an env name that is not an identifier. The line was not printed." >&2
        continue
        ;;
    esac
    value="${trimmed#*=}"
    if [ "${value#\"}" != "$value" ] && [ "${value%\"}" != "$value" ]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [ "${value#\'}" != "$value" ] && [ "${value%\'}" != "$value" ]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    printf -v "$key" '%s' "$value"
    # The name is the file's key, not the literal "key".
    export "${key?}"
  done <"$file"
}

# The branch this VM runs. deploy.yml moves `production` only after CI passed on main.
deploy_branch() {
  local branch="${ENSEMBLE_DEPLOY_BRANCH:-main}"
  case "$branch" in
    '' | -* | *..* | *[!A-Za-z0-9._/-]*)
      echo "ENSEMBLE_DEPLOY_BRANCH is not a plain branch name." >&2
      return 1
      ;;
  esac
  printf '%s\n' "$branch"
}

# git as the ensemble user. HOME is set so git does not try to read root's config.
ensemble_git() {
  runuser -u ensemble -- env HOME=/home/ensemble git -C /opt/ensemble "$@"
}

# hub-api reports this on /health as "commit", so a deploy can wait for the new code.
write_commit_file() {
  local commit
  commit="$(ensemble_git rev-parse HEAD)"
  printf 'ENSEMBLE_COMMIT=%s\n' "$commit" >/etc/ensemble.commit
  chmod 0644 /etc/ensemble.commit
}

require_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is empty. Fill in the env file. The value was not printed." >&2
    return 1
  fi
}

# GitHub's published ed25519 host key. Fingerprint SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
GITHUB_ED25519_HOST_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
GITHUB_ED25519_FINGERPRINT='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
ENSEMBLE_DEPLOY_PUB='/home/ensemble/.ssh/id_ed25519.pub'

ensure_ensemble_user() {
  if ! id -u ensemble >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /home/ensemble --shell /usr/sbin/nologin --user-group ensemble
  fi
  install -d -o ensemble -g ensemble -m 0750 /home/ensemble
  if id ensemble | grep -q '\bsudo\b'; then
    echo "User ensemble is in the sudo group. Remove it. This script will not grant sudo." >&2
    return 1
  fi
}

ensure_deploy_key() {
  local known config fingerprint
  if ! command -v ssh-keygen >/dev/null 2>&1; then
    echo "ssh-keygen is missing. Install openssh-client." >&2
    return 1
  fi
  fingerprint="$(printf '%s\n' "$GITHUB_ED25519_HOST_KEY" | ssh-keygen -lf - | awk '{print $2}')"
  if [ "$fingerprint" != "$GITHUB_ED25519_FINGERPRINT" ]; then
    echo "The pinned github.com host key does not match ${GITHUB_ED25519_FINGERPRINT}." >&2
    return 1
  fi
  install -d -o ensemble -g ensemble -m 0700 /home/ensemble/.ssh
  if [ ! -f /home/ensemble/.ssh/id_ed25519 ]; then
    runuser -u ensemble -- ssh-keygen -t ed25519 -N '' -C 'ensemble-vm-readonly' -f /home/ensemble/.ssh/id_ed25519
    echo "Created a new ed25519 deploy key for user ensemble."
  else
    echo "Deploy key already exists. Not regenerating it."
  fi
  chown ensemble:ensemble /home/ensemble/.ssh/id_ed25519 /home/ensemble/.ssh/id_ed25519.pub
  chmod 600 /home/ensemble/.ssh/id_ed25519
  chmod 644 /home/ensemble/.ssh/id_ed25519.pub
  known=/home/ensemble/.ssh/known_hosts
  printf 'github.com %s\n' "$GITHUB_ED25519_HOST_KEY" >"$known"
  chown ensemble:ensemble "$known"
  chmod 644 "$known"
  config=/home/ensemble/.ssh/config
  cat >"$config" <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile /home/ensemble/.ssh/id_ed25519
  IdentitiesOnly yes
  HostKeyAlgorithms ssh-ed25519
  UpdateHostKeys no
EOF
  chown ensemble:ensemble "$config"
  chmod 600 "$config"
  echo "Public deploy key (read-only). Add this key, then clone."
  echo "----- BEGIN ENSEMBLE DEPLOY KEY -----"
  cat "$ENSEMBLE_DEPLOY_PUB"
  echo "----- END ENSEMBLE DEPLOY KEY -----"
  echo "From a machine that is signed in to GitHub:"
  echo "  gh repo deploy-key add ${ENSEMBLE_DEPLOY_PUB} --title ensemble-vm --repo ensemblework/ensemble"
  echo "GitHub UI: ensemblework/ensemble → Settings → Deploy keys → Add deploy key. Leave write access off."
}

# Caddy's site address is the host in HUB_API_PUBLIC_URL. The committed
# Caddyfile says api.ensemblework.com; install_caddyfile writes that host instead,
# so choosing a domain is a change to the env file, not to git.
caddy_site_host() {
  local url host
  url="$(printf '%s' "${HUB_API_PUBLIC_URL:-}" | tr '[:upper:]' '[:lower:]')"
  if [ -z "$url" ]; then
    echo "HUB_API_PUBLIC_URL is empty. Set it to https://api.<your domain> in the env file." >&2
    return 1
  fi
  host="${url#https://}"
  if [ "$host" = "$url" ]; then
    echo "HUB_API_PUBLIC_URL must start with https:// on the VM." >&2
    return 1
  fi
  host="${host%/}"
  case "$host" in
    */* | *:* | *@*)
      echo "HUB_API_PUBLIC_URL must be https://<host> with no port or path." >&2
      return 1
      ;;
  esac
  if ! printf '%s\n' "$host" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$'; then
    echo "HUB_API_PUBLIC_URL does not name a DNS host that can get a certificate." >&2
    return 1
  fi
  printf '%s\n' "$host"
}

install_caddyfile() {
  local src="$1" dest="${2:-/etc/caddy/Caddyfile}" host tmp
  host="$(caddy_site_host)" || return 1
  tmp="$(mktemp)"
  sed "s/^api\.ensemblework\.com {\$/${host} {/" "$src" >"$tmp"
  if ! grep -Fqx "${host} {" "$tmp"; then
    rm -f "$tmp"
    echo "Could not set the Caddy site address in ${src}." >&2
    return 1
  fi
  install -m 0644 "$tmp" "$dest"
  rm -f "$tmp"
  echo "Caddy site address: ${host}"
}

# Caddy's site address is a hostname, so automatic HTTPS listens on 80 and 443.
caddy_needs_port_80() {
  return 0
}

iptables_rules_path() {
  printf '%s\n' "${ENSEMBLE_IPTABLES_RULES:-/etc/iptables/rules.v4}"
}

chassis_asset_tag() {
  local file
  if [ -n "${ENSEMBLE_CHASSIS_ASSET_TAG+x}" ]; then
    printf '%s' "$ENSEMBLE_CHASSIS_ASSET_TAG"
    return 0
  fi
  file=/sys/class/dmi/id/chassis_asset_tag
  if [ -r "$file" ]; then
    tr -d '\000\r\n' <"$file"
  fi
}

rules_have_reject() {
  local file
  file="$(iptables_rules_path)"
  [ -f "$file" ] && grep -Eq '^[[:space:]]*-A[[:space:]].*[[:space:]]-j[[:space:]]+REJECT([[:space:]]|$)' "$file"
}

insert_accept_dport() {
  local port="$1"
  local file rule
  file="$(iptables_rules_path)"
  rule="-A INPUT -p tcp -m tcp --dport ${port} -j ACCEPT"
  # -e: the rule starts with -A, which grep would otherwise read as a flag.
  if [ -f "$file" ] && grep -Fxq -e "$rule" "$file"; then
    echo "tcp/${port} ACCEPT is already in ${file}."
    return 0
  fi
  install -d -m 0755 "$(dirname "$file")"
  if [ ! -f "$file" ]; then
    cat >"$file" <<EOF
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
${rule}
COMMIT
EOF
    echo "Wrote tcp/${port} ACCEPT into new ${file}."
    return 0
  fi
  python3 - "$file" "$rule" <<'PY'
import sys
path, rule = sys.argv[1], sys.argv[2]
text = open(path).read().splitlines(keepends=True)
reject_at = None
input_reject = None
for index, line in enumerate(text):
    stripped = line.strip()
    if not stripped.startswith("-A ") or " -j REJECT" not in stripped:
        continue
    if reject_at is None:
        reject_at = index
    if stripped.startswith("-A INPUT ") and input_reject is None:
        input_reject = index
insert_at = input_reject if input_reject is not None else reject_at
if insert_at is None:
    for index, line in enumerate(text):
        if line.strip() == "COMMIT":
            insert_at = index
            break
if insert_at is None:
    text.append(rule + "\n")
else:
    text.insert(insert_at, rule + "\n")
open(path, "w").writelines(text)
PY
  echo "Inserted tcp/${port} ACCEPT into ${file} (before an INPUT REJECT when one exists)."
}

reload_persistent_iptables() {
  local file
  file="$(iptables_rules_path)"
  if [ -n "${ENSEMBLE_IPTABLES_RULES:-}" ]; then
    echo "ENSEMBLE_IPTABLES_RULES=${file}. The live filter was not reloaded."
    return 0
  fi
  if ! command -v netfilter-persistent >/dev/null 2>&1; then
    echo "iptables-persistent iptables-persistent/autosave_v4 boolean true" | debconf-set-selections
    echo "iptables-persistent iptables-persistent/autosave_v6 boolean true" | debconf-set-selections
    apt-get install -y --no-install-recommends \
      -o Dpkg::Options::=--force-confdef \
      -o Dpkg::Options::=--force-confold \
      iptables-persistent
  fi
  netfilter-persistent reload
  echo "Reloaded ${file} with netfilter-persistent."
}

# explicit=1 when setup.sh was passed --host-firewall.
# Default (explicit=0) changes nothing, unless this is an Oracle image or
# rules.v4 already contains a REJECT rule. ufw is never used.
configure_host_firewall() {
  local explicit="$1"
  local tag oracle=0 reject=0
  local -a ports=()
  tag="$(chassis_asset_tag || true)"
  if [ "$tag" = "OracleCloud.com" ]; then
    oracle=1
  fi
  if rules_have_reject; then
    reject=1
  fi
  if [ "$explicit" -eq 0 ] && [ "$oracle" -eq 0 ] && [ "$reject" -eq 0 ]; then
    echo "Host firewall unchanged. ufw is not installed or enabled. The cloud firewall (Azure NSG now, Oracle security list later) is the primary firewall."
    return 0
  fi
  if [ "$explicit" -eq 1 ]; then
    ports=(22 443)
    if caddy_needs_port_80; then
      ports+=(80)
    fi
    echo "--host-firewall: writing ACCEPT rules for tcp/22 and tcp/443 into $(iptables_rules_path)."
    if caddy_needs_port_80; then
      echo "Also tcp/80, because the Caddyfile uses a hostname and automatic HTTPS listens on 80."
    fi
  else
    ports=(443)
    if caddy_needs_port_80; then
      ports+=(80)
    fi
    if [ "$oracle" -eq 1 ]; then
      echo "Detected Oracle (chassis_asset_tag=${tag}). ufw is not used."
    else
      echo "rules.v4 already has a REJECT rule. ufw is not used."
    fi
    echo "Inserting tcp/443 ACCEPT so Caddy is reachable. It is placed before an INPUT REJECT when one exists."
    if caddy_needs_port_80; then
      echo "Also tcp/80, because the Caddyfile's automatic HTTPS listens on 80."
    fi
  fi
  local port
  for port in "${ports[@]}"; do
    insert_accept_dport "$port"
  done
  reload_persistent_iptables
}
