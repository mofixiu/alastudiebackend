# aLaStudie local API

This service runs entirely on the local machine. It uses PostgreSQL for durable data, Socket.IO for room events, and a development mailbox stored in PostgreSQL for verification and reset emails. It does not connect to a cloud provider.

## Start locally

1. From this directory, run `npm run db:initialize` once to create an isolated local PostgreSQL cluster in `.local/postgres`.
2. Start it with `npm run db:start`; it uses localhost port `5433` so it won't replace or share an existing PostgreSQL database.
3. Create the database with `createdb -h 127.0.0.1 -p 5433 alastudie`.
4. Copy `.env.example` to `.env` if you need to change local settings, then run `npm install` once and `npm run dev`.
5. The API is available at `http://localhost:4000`; `/health` confirms it is running.
6. Verification and reset messages appear at `/dev/mailbox?email=student@example.test`.

Stop the local database with `npm run db:stop`. The database cluster stays on this computer in the ignored `.local/` directory. Nothing is deployed to a cloud service.

The server applies `schema.sql` on startup. Set `ADMIN_EMAILS` to a comma-separated list of staff emails to enable the private report queue. Keep `.env` local.

## Demo content

With PostgreSQL and the API environment configured, run `npm run seed:demo`. This idempotently adds six clearly labeled demo accounts, eight rooms, example tasks and chat, and private sample focus history. Sign in with either the username (`nia_demo`, `tobi_demo`, `zara_demo`, `ade_demo`, `maya_demo`, `sam_demo`) or matching email (`nia@demo.alastudie.test`, `tobi@demo.alastudie.test`, `zara@demo.alastudie.test`, `ade@demo.alastudie.test`, `maya@demo.alastudie.test`, `sam@demo.alastudie.test`). The shared local-only password is `DemoStudy8!`. The link-only room uses code `STUDY777`. Do not use demo credentials for a hosted environment.

Public room shares open a small room preview page at `/share/rooms/<room-id>`. From the app, recipients can search the exact room name in Discover and join. For sharing across devices on your local network, build with `--dart-define=PUBLIC_SHARE_BASE_URL=http://<reachable-host>:4000`; without that setting, the link uses the app's local API address. Rooms can start immediately or have one-off, daily, or weekly schedules. A scheduled room's host-led timer is available during its scheduled occurrence (a four-hour study window); repeated occurrences reuse the same room and link. The Home and My rooms pages link to a Calendar with per-meeting RSVPs, 24-hour in-app reminders, cancellations, and check-in attendance. Discover supports subject, course, start-time, and available-seat filters. Hosts can save room templates and assign co-hosts; private study summaries and history are available in Profile, with session history exportable as CSV.

## Tests

Run `npm run typecheck` for the backend type check. The integration suite uses a disposable PostgreSQL database and starts a separate local API process. Create a test database whose name contains `test`, then run `TEST_DATABASE_URL=postgres://.../alastudie_test npm run test:integration`. The suite refuses database names without `test` in them. It exercises account verification/recovery and username/email sign-in, room access and discovery filters, recurring calendar occurrences/RSVPs/reminders/attendance/cancellations, templates and co-host permissions, per-member tasks, live presence and shared sessions, chat and DMs, private statistics, reports, and moderation. Flutter tests cover offline sync, response models, navigation, theme, and CSV export.

For an Android emulator, set Flutter's API base URL to `http://10.0.2.2:4000`. For an iOS simulator, use `http://127.0.0.1:4000`.
