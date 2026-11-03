# Simplylearn development

Use Node.js 20.19 or newer (Node.js 24 is verified) and MongoDB 7 or newer.

```sh
npm ci
npm start
```

The server connects to `mongodb://127.0.0.1:27017/simplylearn` by default and
listens on port 1690. Set `MONGODB_URI` and `PORT` to use another database or port.
Keep database credentials in the environment rather than source control.
The server starts listening after MongoDB connects and exits unsuccessfully
if startup fails.

```sh
npm run dev  # restart automatically with Node's built-in watch mode
npm test     # database-backed HTTP, upload and Socket.IO integration tests
```

Tests require a running MongoDB instance. They use the separate `simplylearn_test`
database by default; set `TEST_MONGODB_URI` to override it. Each run creates
temporary classrooms and removes its own documents and uploaded files. The suite
also checks browser behavior with jsdom, including reconnects, slide navigation,
safe chat rendering, and clipboard links.

## Classroom ownership and files

The browser that creates a classroom receives a private, HttpOnly, SameSite=Strict
cookie granting access to that classroom's teacher pages, shared slide controls,
and termination endpoint. The database stores only the credential's hash. The
cookie lasts 30 days unless the classroom is terminated sooner. Keep using the
creating browser and do not clear its cookies while teaching. Student links grant
viewing/chat access without teacher permissions and use the current site's origin.

Existing classrooms created before this change have no ownership credential.
They remain viewable, but must be recreated to use teacher controls; ownership
cannot safely be inferred from a name or public classroom ID. Their old files
are not automatically removed.

Each new classroom has its own `uploads/<classroom-id>/` directory. Slide filenames
are generated, independent of display names and original filenames. Uploads are
limited to 40 PNG/JPEG slides of at most 5 MiB each, with image signature checks;
invalid submissions are rejected and their temporary files removed. Termination
deletes only that classroom's directory and notifies its participants.

Shared slide changes are validated and saved to MongoDB. Reconnecting clients
rejoin their room, and late/reconnecting participants receive the saved slide.

This update uses Express 5, EJS 7, Mongoose 9, Multer 2 and Socket.IO 4.
Mongoose operations use promises instead of the removed callback API.
The Socket.IO browser client is served by the server at `/socket.io/socket.io.js`;
external clients must also use a compatible Socket.IO 4 client.

In the previously prepared cloud environment, the local database can be started
with `/workspace/.simplylearn-dev/database-start.sh`. Then use the npm commands
above directly: the old `app-start.sh` preload adds MongoDB driver options that
are no longer supported by Mongoose 9.
