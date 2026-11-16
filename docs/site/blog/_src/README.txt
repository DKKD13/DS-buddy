Source of the Tacit 1.0 launch post served from docs/site/blog/.

content/zh.md   the Chinese text
content/en.md   the English text
build.py        turns the two files into index.html, en/index.html and style.css, and draws the six diagrams

To rebuild: copy the screenshots from ../img into ./img, run `python3 build.py` here, then copy public/ over docs/site/blog/.
No dependencies beyond Python 3.
