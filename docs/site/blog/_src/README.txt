Source of the DS-buddy launch post served from docs/site/blog/.

content/zh.md, content/en.md             the short essay, Chinese and English
content/zh-deep.md, content/en-deep.md   the long version, with comparisons and screenshots
build.py                                 turns the four files into index.html, deep/, en/, en/deep/ and style.css, and draws the diagrams

To rebuild: copy the screenshots from ../img into ./img, run `python3 build.py` here, then copy public/ over docs/site/blog/.
No dependencies beyond Python 3.
