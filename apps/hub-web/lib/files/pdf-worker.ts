// pdf.js's worker, with stream iteration added for WebKit (stream-iteration.ts). The worker only
// reads streams once a document arrives, after this module has run.
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
import { installStreamIteration } from "./stream-iteration";

installStreamIteration();
