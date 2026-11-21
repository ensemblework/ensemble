---
name: web-files
description: Use when your owner wants a paper, PDF, datasheet, manual or another document from the web, or asks you to add a file to their Ensemble Files.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: paper, papers, pdf, pdfs, arxiv, cvpr, iccv, eccv, wacv, neurips, icml, iclr, acl, emnlp, naacl, whitepaper, datasheet, datasheets, manual, manuals, ebook, my files, ensemble files, to my files
  tools: hub_save_file
  source: Ensemble Node's files from the web skill.
---
- Find the official source: CVPR, ICCV, WACV → openaccess.thecvf.com; ACL, EMNLP, NAACL → aclanthology.org; NeurIPS → proceedings.neurips.cc; ICLR → openreview.net; else the publisher or the authors' page. arXiv only if your owner allows it.
- Into your owner's Ensemble Files: hub_save_file with url, the direct PDF link (not the paper's page). When the site needs the browser: browser_fetch, then hub_save_file with its evidence id.
- Link only what hub_save_file returned (its ensemble://file/… link); never write a link yourself.
- Into this chat instead: node_share_file (a file on the computer); it comes with your reply.
- A file your owner attached here is already in their Files: hub_save_file with attachment (its name) gives its link.
