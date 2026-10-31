---
name: web-files
title: Save files from the web
when: put a paper, PDF or document from a web address into Ensemble Files
tools: hub_save_file, hub_web_search, hub_list_files
requires: hub_save_file
match: \b(papers?|arxiv|cvpr|iccv|eccv|wacv|neurips|icml|iclr|emnlp|naacl|whitepapers?|datasheets?)\b|\b(add|save|put|upload|store)\b[^.?!\n]{0,60}\b(from|off) (the )?(web|internet|site|website|link|url)\b
---
Find the official copy
- hub_web_search for the title, with the venue or year. Prefer the official source: CVPR, ICCV, WACV → openaccess.thecvf.com; ACL, EMNLP, NAACL → aclanthology.org; NeurIPS → proceedings.neurips.cc; ICLR → openreview.net; otherwise the publisher or the authors' page. arXiv only when the person allows it.
- Use the direct file link (it ends in .pdf or downloads the file), not the paper's web page.

Save it
- hub_save_file with url: the direct link, and name when the file name should be clearer. It returns the saved file and its link.
- A web page instead of a file is refused: find the PDF link in the search results and try again.

Answer
- Give only the link hub_save_file returned. Never write an ensemble:// link yourself, and never say a file is saved unless the tool said so.
- Already in Files? hub_list_files with the title first; do not save it twice.
