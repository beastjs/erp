# Welcome to your Convex functions directory!

Write your Convex functions here.
See https://docs.convex.dev/functions for more.

A query function that takes two arguments looks like:

```ts
// convex/myFunctions.ts
import { query } from "./_generated/server";
import { v } from "convex/values";

export const myQueryFunction = query({
  // Validators for arguments.
  args: {
    first: v.number(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Read the database as many times as you need here.
    // See https://docs.convex.dev/database/reading-data.
    const documents = await ctx.db.query("tablename").collect();

    // Arguments passed from the client are properties of the args object.
    console.log(args.first, args.second);

    // Write arbitrary JavaScript here: filter, aggregate, build derived data,
    // remove non-public properties, or create new objects.
    return documents;
  },
});
```

Using this query function in a React component looks like:

```ts
const data = useQuery(api.myFunctions.myQueryFunction, {
  first: 10,
  second: "hello",
});
```

A mutation function looks like:

```ts
// convex/myFunctions.ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const myMutationFunction = mutation({
  // Validators for arguments.
  args: {
    first: v.string(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Insert or modify documents in the database here.
    // Mutations can also read from the database like queries.
    // See https://docs.convex.dev/database/writing-data.
    const message = { body: args.first, author: args.second };
    const id = await ctx.db.insert("messages", message);

    // Optionally, return a value from your mutation.
    return await ctx.db.get("messages", id);
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.myFunctions.myMutationFunction);
function handleButtonPress() {
  // fire and forget, the most common way to use mutations
  mutation({ first: "Hello!", second: "me" });
  // OR
  // use the result once the mutation has completed
  mutation({ first: "Hello!", second: "me" }).then((result) =>
    console.log(result),
  );
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `npx convex -h` in your project root
directory. To learn more, launch the docs with `npx convex docs`.

## First deploy: nothing works until you bootstrap an admin

A fresh deployment has no `memberships`, and every public function requires one, so **every call is refused with
`forbidden: not a member of this org` for everyone, the intended admin included.** This is the system failing closed,
not a bug, and it must not be "fixed" by relaxing `requireRole`. `bootstrapMember` is the **trust root**: an internal
function only an operator of the deployment (CLI or dashboard) can run, because nobody inside an org can be its first
admin. It is also the way back from any lockout, and it is audited as the `membership_bootstrap` system process.

No function creates an org either, so first insert one `orgs` row (dashboard, Data tab: `{ "name": "Acme", "createdAt": 0 }`)
and copy its `_id`. Then, per org:

```bash
npx convex run members/api:bootstrapMember '{"orgId": "<orgs _id>", "userId": "<tokenIdentifier>", "role": "admin"}'
```

`userId` is the identity's `tokenIdentifier` (issuer and subject joined by `|`, e.g. `https://your-issuer.example|user_123`),
not the bare subject. The org the caller acts in comes from the `orgId` claim on their token and must be that same `_id`.
Add `--prod` to target production. After this, the admin grants everyone else through `members/api:setMemberRole`.

## Admin-tier functions are actions

These seven are public **actions**, not mutations or queries, so that an authorization refusal can be recorded
(`observability/refusals.ts`; read with `observability/refusals:refusalCounts`): `members/api:setMemberRole`,
`privacy/api:requestErasure`, `privacy/api:suppressIdentifier`, `runs/mutations:startRun`,
`sources/mutations:registerSource`, `audit/api:recentAudit`, `audit/api:auditForTarget`. Clients must call them as
actions (`useAction`, `client.action`, `npx convex run` works unchanged). `recentAudit` and `auditForTarget` are
therefore **not reactive**: fetch again to see new entries. An authorization refusal arrives as a `ConvexError` whose
`data` is `{ code: "forbidden", reason }`; match on `data`, not on the message text.

## Observability reads take `asOf`: re-issue it on a timer

`observability/health:pipelineHealth`, `observability/health:stalledErasures` and `observability/quality:dataQuality`
take an `asOf` (epoch ms) because a Convex query must not read the clock. The value is fixed for the life of a
subscription: a screen that subscribes once at load judges staleness against the load time forever, so **work that
wedges after the screen opened never appears on it**, because nothing a wedged chain does changes the rows the query
reads. A client must re-issue the query with a fresh `asOf` on a timer (once a minute is ample; every threshold is at
least 10 minutes), e.g. keep `asOf` in state and update it from `setInterval`. A finite, non-negative value is required;
anything else is refused.

A stalled import-chunk purge (`pipelineHealth.stalledPurges`) is restarted with `sources/import:resumePurge`
(operator); an import listed in phase `staging` is closed with `runs/mutations:finishRun`, which purges its raw rows.
