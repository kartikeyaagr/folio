#!/usr/bin/env bash
#
# Once, on a box set up before 28-Sep-2026, when the system was called Trisula: move it onto
# Folio's names. Run this INSTEAD of SETUP.md §14 for the deploy that first carries the rename.
# §14 copies the new folio-* units in beside the installed trisula-* ones, and both sets would
# then run: two web servers contending for 3100 and every job twice.
#
#   sudo systemctl stop 'trisula-*'      # timers, web, both watchers, any job mid-run
#   sudo -u trisula git -C /srv/trisula pull
#   sudo bash /srv/trisula/ops/rename-box.sh
#
# Everything is stopped before the pull, not just the timers. A watcher that crash-restarts after
# the pull would otherwise run the new code against a schema that is not migrated yet.
#
# Renames the unix user and group (same uid and gid, so ownership follows), /srv, /etc, /var/lib
# and /run, the env file, the database and its role, the Tailscale node and APP_URL, and the units.
# It re-enables the same set that was enabled before. AWS keeps its names: ops/provision.sh says
# why. So does BACKUP_S3_BUCKET.
#
# Safe to re-run. Each step checks whether it has already happened, so a run that dies halfway is
# resumed rather than wedged.
set -euo pipefail

OLD=trisula NEW=folio
UNITS_FILE=/root/$NEW-rename.units
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
REPO=/srv/$NEW; [ -d "$REPO" ] || REPO=/srv/$OLD
[ -f "$REPO/ops/systemd/$NEW-web.service" ] || die "$REPO has no $NEW units; pull the renamed tree first"

# Captured once, before anything is disabled, because a re-run after the old units are gone would
# otherwise read an empty list and bring nothing back.
say "units"
[ -f "$UNITS_FILE" ] || systemctl list-unit-files "$OLD-*" --state=enabled --no-legend \
  | awk '{print $1}' >"$UNITS_FILE"
echo "will re-enable: $(tr '\n' ' ' <"$UNITS_FILE")"
if compgen -G "/etc/systemd/system/$OLD-*" >/dev/null; then
  # shellcheck disable=SC2046
  systemctl disable --now $(cat "$UNITS_FILE") 2>/dev/null || true
  # A job caught mid-run is stopped, not lost: every sweep asks what has no run yet.
  systemctl stop "$OLD-*" 2>/dev/null || true
  rm -f /etc/systemd/system/"$OLD"-*
  systemctl daemon-reload
fi

say "user and group"
if id "$OLD" >/dev/null 2>&1; then
  ! id "$NEW" >/dev/null 2>&1 || die "both $OLD and $NEW users exist; sort that out by hand"
  # -m moves the home, which is the checkout itself (SETUP.md §5): /srv/$OLD becomes /srv/$NEW.
  usermod -l "$NEW" -d "/srv/$NEW" -m "$OLD"
  groupmod -n "$NEW" "$OLD"
fi
REPO=/srv/$NEW

say "directories and env file"
[ ! -e "/var/lib/$OLD" ] || mv "/var/lib/$OLD" "/var/lib/$NEW"
[ ! -e "/etc/$OLD" ] || mv "/etc/$OLD" "/etc/$NEW"
[ ! -e "/etc/$NEW/$OLD.env" ] || mv "/etc/$NEW/$OLD.env" "/etc/$NEW/$NEW.env"
rm -rf "/run/$OLD"
# Paths and the database only. BACKUP_S3_BUCKET names a bucket that keeps its name, and SMTP_FROM
# is a real mailbox, so neither is touched.
sed -i -e "s#/var/lib/$OLD/#/var/lib/$NEW/#g" -e "s#/run/$OLD/#/run/$NEW/#g" \
  -e "s#^DATABASE_URL=postgres:///$OLD\$#DATABASE_URL=postgres:///$NEW#" "/etc/$NEW/$NEW.env"
# Dumps are --no-owner, so the prefix is only a name — but backup.sh prunes by it, and archives
# left under the old one would never age out.
for f in /var/lib/"$NEW"/backups/"$OLD"-*.dump.age; do
  if [ -e "$f" ]; then mv "$f" "${f%/*}/$NEW-${f##*/"$OLD"-}"; fi
done

say "tailscale"
# SETUP.md §8a names the node, and APP_URL is the https://<node>.<tailnet>.ts.net that `tailscale
# serve` answers on, so the two move together. `tailscale serve` keeps its config across the rename
# and issues a certificate for the new name on first request. That is Tailscale's documented
# behaviour, but this step has not yet been run on a live tailnet. A box not on Tailscale has
# nothing to move, and the step is a no-op there.
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  tailscale set --hostname="$NEW"
fi
sed -i -e "s#^APP_URL=https://$OLD\.#APP_URL=https://$NEW.#" "/etc/$NEW/$NEW.env"

say "database and role"
psql_() { sudo -u postgres psql -v ON_ERROR_STOP=1 -tAc "$1"; }
if [ "$(psql_ "SELECT 1 FROM pg_database WHERE datname = '$OLD'")" = 1 ]; then
  # ALTER DATABASE refuses while anything else is connected, and says only how many. With every
  # unit stopped, what is left is a unit the stop missed or somebody's psql, and neither should be
  # killed from here. Name them and stop; closing them and re-running resumes at this step.
  held=$(psql_ "SELECT string_agg(format('pid %s %s (%s)', pid, usename,
                  coalesce(nullif(application_name, ''), 'no application name')), '; ')
                FROM pg_stat_activity WHERE datname = '$OLD' AND pid <> pg_backend_pid()")
  [ -z "$held" ] || die "database $OLD is still in use, so it cannot be renamed: $held"
  psql_ "ALTER DATABASE $OLD RENAME TO $NEW"
fi
# Peer authentication maps the unix user to the role of the same name, so the two move together.
[ "$(psql_ "SELECT 1 FROM pg_roles WHERE rolname = '$OLD'")" != 1 ] \
  || psql_ "ALTER ROLE $OLD RENAME TO $NEW"

say "checkout"
cd "$REPO"
sudo -u "$NEW" git remote set-url origin "git@github.com:kartikeyaagr/$NEW.git"
sudo -u "$NEW" git config core.sshCommand "ssh -i /etc/$NEW/deploy_key -o IdentitiesOnly=yes"
# Both carry the old absolute path: pnpm records its store under the old home, and .next records
# the old app directory. A clean install relinks from the moved store rather than downloading.
rm -rf node_modules .next
sudo -u "$NEW" pnpm install --frozen-lockfile
sudo -u "$NEW" bash -c "set -a; . /etc/$NEW/$NEW.env; set +a; pnpm migrate"
sudo -u "$NEW" pnpm build

say "units, back on"
cp ops/systemd/*.service ops/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
# The identity token first: agents 401 until it exists, and the timer's first tick is minutes away.
if grep -qx "$OLD-identity-token.timer" "$UNITS_FILE"; then
  systemctl start "$NEW-identity-token.service"
fi
sed "s/^$OLD-/$NEW-/" "$UNITS_FILE" | xargs -r systemctl enable --now

# A for loop's status is its last sleep's, so "|| die" after the loop could never fire.
up=
for _ in $(seq 30); do curl -fsS localhost:3100/api/health && { up=1; break; }; sleep 2; done
[ -n "$up" ] || die "$NEW-web did not answer on 3100; journalctl -u $NEW-web -n 50"
rm -f "$UNITS_FILE"
echo
systemctl list-timers "$NEW-*" --no-pager
