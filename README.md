# Simplylearn development

Use Node.js 20.19 or newer (Node.js 24 is verified) and MongoDB 7 or newer.
Presentation conversion also requires Linux, LibreOffice Impress, Poppler
(`pdfinfo` and `pdftoppm`), and `prlimit` from util-linux. The Docker image below
includes these tools and common substitute fonts. Use Docker on Windows/macOS.

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

## PPTX and PDF uploads

Teachers can choose one `.pptx` or `.pdf` instead of individual images. The upload
form selects the appropriate upload endpoint automatically. The presentation
limit is 25 MiB and 40 slides/pages; images retain their 5 MiB per-file limit.
PPTX hidden slides count toward the input limit but are excluded from output.
PPTX presenter notes are excluded; all pages in an uploaded PDF are rendered.
Animations, embedded video/audio and interactive content become static images.

After uploading, the creating browser sees a conversion status page. One worker
processes presentations at a time. Classrooms have `queued`, `processing`,
`ready` or `failed` status, and only ready classrooms accept student sessions.
The teacher can discard a queued, processing or failed classroom. Failures show
an explanation and never publish partial slides.

PPTX files are rendered to PDF with a separate LibreOffice profile for each job;
PDF pages are rendered to JPEG images with a longest edge of 1600 pixels and
quality 82. Files are numbered in slide order. The converter checks archive
structure, expanded size, external media references, signatures and page count.
Subprocesses have memory, CPU, output-file and time limits; a conversion has a
two-minute deadline. Source files, intermediate PDFs and profiles stay outside
the public upload directory and are removed after success, failure or cancellation.

Queued work is persisted in MongoDB. Graceful shutdown puts interrupted work
back in the queue, and startup recovers queued/interrupted jobs when their source
files are available. Persist the entire data directory to retain both uploaded
slides and queued source files across deployments. No external conversion API is
used. `SOFFICE_BIN`, `PDFINFO_BIN` and `PDFTOPPM_BIN` optionally select executable paths.

Missing fonts can change PPTX layout. The image contains Carlito and Caladea as
metric-compatible substitutes for Calibri/Cambria, plus Liberation and Noto.
For the closest match to PowerPoint, export a PDF with embedded fonts and upload it.

## Docker deployment

```sh
docker build -t simplylearn .
# First set MONGODB_URI to an accessible MongoDB connection string.
docker run --rm -p 1690:1690 --memory=2g --pids-limit=128 \
  --env MONGODB_URI --mount source=simplylearn-data,target=/app/data simplylearn
```

The image runs the app and converters as an unprivileged user. Its entrypoint
initializes permissions on the data volume. Application code stays read-only to
that user. `DATA_DIR` defaults to `/app/data` in Docker and the checkout directory
for native development. It contains `uploads/` and private `.conversion-jobs/`.
When moving an existing deployment, copy its uploads into `DATA_DIR/uploads`.

For Render or another Docker host, use the repository Dockerfile, configure
`MONGODB_URI`, attach a persistent disk at `/app/data`, and keep one app instance.
The queue, file storage and live Socket.IO room adapter currently assume one
instance. A 2 GiB memory allocation is a starting point; large/complex decks may
need more resources or an exported PDF. The host-provided `PORT` is supported.

For native Debian development, install `libreoffice-impress poppler-utils util-linux
fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core`
using the system package manager, then use the npm commands above. Conversion
tests run the actual tools; the browser tests also verify independent student
browsing and teacher-driven resynchronization.

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
