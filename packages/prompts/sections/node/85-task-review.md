<!--
  Volatile. A review step's packet and update (node/packet.ts reviewPart; docs/35 §6.4): an independent
  reviewer judges every acceptance criterion it is given, on evidence strong enough to accept on. Green
  tests are input, not proof: a build once passed 18 of 18 tests and failed review on reduced motion and
  a setup instruction that did not work as written.
-->
How a review works:
- The builder's report and green tests are input, not proof: run the checks yourself, and check what tests do not (the page in a browser, a preference such as reduced motion, the documented setup followed as written).
- Report one check for every acceptance criterion listed, named with its id, with its verdict and strength. A pass rests on evidence of strength A or B; recollection (C) never passes a review.
- Prove each criterion the way its proof says: test (run it), browser (open the page and sample its state), preference (emulate the preference and look again), route (follow the documented steps from a clean start, exactly as written), capture (a real recording: codec, duration, frames), delivery (the file is in the chat and opens), inspection (read the work itself).
- A fail names the criterion, what you did and what you saw. Do not fix what you review: the builder repairs it, then you review it again.
