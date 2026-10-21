# GridGrader

A Chrome / Edge / Brave extension that finds every submitted file on a page and shows them side by side in a resizable grid, so you can review many student files without downloading each one separately.

## Install (2 minutes)

1. Unzip `GridGrader.zip` somewhere permanent (for example `Documents\GridGrader`).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped `GridGrader` folder.
5. Pin the extension (puzzle icon → pin).

## Use

1. Open the page with the submissions (Moodle grading page, Google Classroom, any LMS or folder listing) and make sure you are signed in.
2. Click the GridGrader icon (or press **Alt+G**).
3. Untick anything you don't want, or use **Open files [from] to [to] → Select range** to pick e.g. files #1–10, then click **Open N files in grid**.
4. In the grid:
   - **Columns** and **Height** sliders: how many files you see at once.
   - Hover any icon to see what it does. Each file has **Side view** and **Full screen** buttons (clicking the name uses the last one you picked). Use ← → to move between students and Esc to close.
   - **Side view** docks the file on the left while the other submissions keep scrolling on the right. Drag the panel's right edge to resize it, or double-click the edge for half the screen.
   - **Logisim circuits**: in the large view, scroll to move around (Shift+scroll sideways), **Ctrl+scroll** or pinch to zoom, drag to pan, and **Fit view** (or double-click) to see the whole circuit. Grid cards work the same way, with a small zoom bar when you hover the card (scroll in the gaps between cards to scroll the page).
   - **Marks / note** box under each file: saved automatically. Export them with **More → Export marks/notes (CSV)**.
   - **Select several files:** click a card's number (Shift-click for a range, or Ctrl-click the name). A bar appears with **Compare** (exactly 2), **Open in tabs**, **Download ZIP** and **Remove**.
   - **Compare** shows two submissions side by side, each with its own notes box.
   - The **Filter** menu has **Selected only** (hides every card you have not ticked) and sorting by student name, file name, file type, newest/oldest submission, late first, or most similar.
   - **Late submissions** get a red LATE tag (hover it to see how late). The clock button in the toolbar shows only late ones.
   - **More → Find similar circuits** compares every Logisim file with every other one and lists suspiciously similar pairs, even if the copy was moved or relabelled. Click **Compare** on a pair to check it yourself.
   - **Keyboard:** J/K next/previous card, S or Enter side view, F full screen, N note, X select, C compare, O new tab, D download, / search, Esc close. Press **?** for the full list.
   - **More → Download all as ZIP**: one ZIP with every file, named by student.
   - **+ Add files**, or drag files onto the page, to view files from your computer.
   - **Audio & video players** already on the page (lecture recordings, voice notes) are picked up too, even without a file extension.
   - **ZIP submissions**: click **View** next to any file inside to open it as its own tile.

## What it can show

| Type | Formats |
|---|---|
| Documents | PDF (all pages), Word .docx (full layout), PowerPoint .pptx (slide text and images), old Word .doc and PowerPoint .ppt (text, tables and pictures), RTF |
| Spreadsheets | .xlsx, .xls, .ods, .csv, .tsv (with sheet tabs) |
| Media | Images (png, jpg, gif, webp, svg, bmp), video (mp4, webm, mkv, mov; avi/wmv need download), audio (mp3, wav, ogg, m4a, aac, flac, opus) |
| Code / text | Not listed when scanning a page. Code inside a ZIP or dragged in still opens with line numbers |
| Notebooks | Jupyter .ipynb (cells and outputs) |
| CAD / 3D | STL and OBJ (rotatable 3D in the large view) |
| Circuits | Logisim .circ (schematic drawing with component counts; double-click a subcircuit to open it) |
| Archives | ZIP (browse and open the files inside) |
| Anything else | File info, hex preview and readable text (DWG, STEP, SolidWorks etc. need their own apps) |

## Notes

- Everything runs in your browser. Files are never uploaded anywhere.
- If a site shows a login page instead of the file, open the submissions page in a normal tab first (signed in), then press **Retry** on that tile. The extension tries again using that tab's login.
- Google Drive and Classroom links are converted to direct downloads. This works for files your account can open.
- Old .doc and .ppt files show their text, tables and pictures, but not their exact layout. Password-protected Office files and closed CAD formats (DWG, SolidWorks) can't be shown. Use the download button for those.
