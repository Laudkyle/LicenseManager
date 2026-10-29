# LicenseDesk

LicenseDesk is a self-hosted product license manager built with React, Tailwind CSS, Express, and PostgreSQL. It imports the records and fields from the supplied `license_entries.sql` into PostgreSQL migrations and seed data. It does not require Docker or alter the AppWatch database.

## Features

- Account sign-up, email verification, sign-in, password reset, and sign-out.
- Account profile and password settings, plus dark and light themes.
- Private per-account license records enforced by PostgreSQL ownership and API authorization.
- Searchable license inventory with status filters, CSV export, and create/edit/delete actions.
- Overview cards, expiry outlook, vendor portfolio, renewal watch, and recently updated records.
- Automatic status calculation from expiry and renewal dates; suspended records remain suspended.
- Responsive layout with readable select menus in both themes.
- Database migrations run automatically when the server starts.

## Start locally with PostgreSQL

1. Create a separate database (or use the `license_manager` database already created for this project). With PostgreSQL on your PATH:

   ```powershell
   createdb -U postgres license_manager
   ```

   Or create a database named `license_manager` owned by `postgres` in pgAdmin. This project does not use Docker.

2. Copy `.env.example` to `.env`. Set `DATABASE_URL` and a random `SESSION_SECRET` with at least 32 characters. In development, verification and reset links print to the backend console when SMTP is not configured. Configure SMTP to send account verification, password recovery, and email-change messages. `APP_BASE_URL` must be the URL users open in their browser (default `http://localhost:5174`). Keep `.env` private.

3. Install dependencies and start the UI and API:

   ```powershell
   npm install
   npm run dev
   ```

   Open <http://localhost:5174>. The backend listens on <http://127.0.0.1:3002>. Schema migrations run automatically. The first account created claims the legacy imported records from the seed database; records created afterwards are scoped to their owning account. Each account can only read and change its own records.

Without SMTP, development mode prints secure verification and password-reset links in the backend console, so local sign-up and recovery still work. Production mode requires SMTP and will not expose these links in logs.

## Production

Run `npm run build`, then `npm start`. Set `NODE_ENV=production`, use a random session secret of at least 32 characters, configure SMTP, and place the app behind HTTPS before making it reachable from another device. Set `COOKIE_SECURE=true` when TLS terminates in front of the app. The default host binds to your local computer; change `HOST` only when you intend to expose it to a network.

## License status rules

- **Expired:** the expiry date is before today.
- **Renewal due:** the renewal date has arrived, but the license has not expired.
- **Expiring soon:** the license expires within 30 days.
- **Active:** more than 30 days remain.
- **Suspended:** a user has suspended the record.

Statuses are calculated from saved dates and change automatically as time passes.

## API

All routes use `/api`. License, dashboard, and account-setting routes require a verified account session.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Check API and database connectivity |
| `POST` | `/auth/signup` | Create an account and send verification email |
| `POST` | `/auth/login` | Sign in to a verified account |
| `GET` | `/auth/me` | Read the signed-in account |
| `POST` | `/auth/verify-email` | Verify an email address |
| `POST` | `/auth/resend-verification` | Resend a verification message |
| `POST` | `/auth/forgot-password` | Request a password reset |
| `POST` | `/auth/reset-password` | Set a password using a reset token |
| `POST` | `/auth/logout` | End the current session |
| `GET`, `PUT` | `/settings`, `/settings/profile`, `/settings/password` | Read and update account settings |
| `GET` | `/dashboard` | Read account totals, renewal watch, and vendor summary |
| `GET` | `/licenses` | Search and filter the signed-in account's licenses |
| `POST` | `/licenses` | Create a license |
| `PUT` | `/licenses/:id` | Update an owned license |
| `DELETE` | `/licenses/:id` | Remove an owned license |


