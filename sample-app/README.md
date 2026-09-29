# VerifyPass React Sample

This sample defaults to the live test API:

```text
https://uybb6wv27prwyijtkcteovvvke0hfkqw.lambda-url.us-east-2.on.aws
```

It also embeds the test public key:

```text
vp_pub_test_g0CAzW80fTNG5GJYV2wA1XUFFXov7VU9
```

Run locally:

```bash
npm ci
npm run dev
```

The test harness asks for a `vp_sec_test_...` key at runtime so you can create sessions while testing. Do not commit or bundle the secret key in browser code. In a production integration, create sessions on your server with `VERIFYPASS_SECRET_KEY` and return only `sessionId` and `sdkToken` to the React app.
