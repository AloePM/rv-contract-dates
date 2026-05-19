# rv-contract-dates — Cloud Run Job

One-time Cloud Run Job that sets `dateContractBegins` on Rentvine properties
using dates from your `property_directory-20260518.csv`.

**Rules:**
- If a property already has `dateContractBegins` in Rentvine → **skipped** (never overwritten)
- If blank → sets it to `Property Created On` from the CSV
- Logs everything to Cloud Run logs, exits when done

---

## Deploy & run (one command each)

Replace `YOUR_PROJECT_ID` with your GCP project.

```bash
# 1. Authenticate
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# 2. Build and push image
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/rv-contract-dates

# 3. Create the Cloud Run Job
gcloud run jobs create rv-contract-dates \
  --image gcr.io/YOUR_PROJECT_ID/rv-contract-dates \
  --region us-central1 \
  --set-env-vars DRY_RUN=false \
  --max-retries 0

# 4. Execute it
gcloud run jobs execute rv-contract-dates --region us-central1

# 5. Watch the logs
gcloud run jobs executions list --job rv-contract-dates --region us-central1
# Then grab the execution name and:
gcloud logging read "resource.labels.job_name=rv-contract-dates" \
  --format="value(textPayload)" --limit=500
```

---

## Dry run first (recommended)

```bash
# Create job with DRY_RUN=true to preview without writing
gcloud run jobs create rv-contract-dates-dry \
  --image gcr.io/YOUR_PROJECT_ID/rv-contract-dates \
  --region us-central1 \
  --set-env-vars DRY_RUN=true \
  --max-retries 0

gcloud run jobs execute rv-contract-dates-dry --region us-central1
```

Logs will show exactly which properties would be updated and what dates
would be set, without touching Rentvine.

---

## Environment variables

| Variable  | Default | Description |
|-----------|---------|-------------|
| `DRY_RUN` | `false` | Set to `true` to preview without writing |
| `RV_AUTH` | hardcoded | Override Rentvine Basic auth header if needed |

---

## After it runs

Pull a fresh Units export from Rentvine and upload to Claude to regenerate
the portfolio growth dashboard with accurate contract dates.
