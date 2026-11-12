# The ServerLife guide

**What everything in the app does.** The README is for getting it built and
installed; this is the reference for using it — every panel, every menu, and
the reasoning where the reasoning matters.

It is also *in* the app: **Help → Guide** (or `⌘/`) opens this same text with
a section list and a search box, because the moment you want it is while you
are looking at the thing you are asking about.

---

## Contents

- [Sessions and connections](#connections)
- [The file browser and transfers](#file-browser-and-transfers)
- [Starred hosts and folders](#starred-hosts-and-folders)
- [Folders in the host list](#folders-in-the-host-list)
- [What a host remembers](#what-a-host-remembers)
- [Keyword highlighting](#keyword-highlighting)
- [Local shells](#local-shells)
- [tmux: sessions that outlive the window](#tmux)
- [Consoles and screens: serial, telnet, VNC and RDP](#consoles-and-screens)
- [Saving what you are looking at](#saving-what-you-are-looking-at)
- [Adding servers](#adding-servers)
- [Running one command](#running-one-command)
- [Command snippets](#command-snippets)
- [Macros](#macros)
- [Fleet operations](#fleet-operations)
- [Port forwarding](#port-forwarding)
- [X11 forwarding](#x11-forwarding)
- [Per-session MFA](#per-session-mfa)
- [Keys and known hosts](#keys-and-known-hosts)
- [Teleport](#teleport)
- [Beams](#beams)
- [KubeLife](#kubelife)
- [Windows](#windows)
- [S3](#s3)
- [Network and certificate tools](#network-and-certificate-tools)
- [The AI assistant](#the-ai-assistant)
- [Search everything](#search-everything)
- [Interface](#interface)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

---

## Connections

**Both kinds of host, one list.** Teleport nodes from every logged-in profile
appear grouped by cluster with their labels; SSH config hosts appear below.
Nothing needs to be registered with the app first.

**Quick connect** (`⌘⌥C`) for a server that is in no inventory yet. Type
`ubuntu@10.0.0.5`, or paste the whole `ssh -p 2222 -i key user@host` line from
the ticket you were sent, and get three choices: **Test connect** dials once and
reports who and what answered, a **single command** runs and prints its output
in the dialog without opening a terminal, and **Connect** opens a session.
Nothing is written to `~/.ssh/config` or saved as a profile — *Save as server…*
is there when it turns out to be a machine you keep. The New session dialog
(`⌘N`) offers the same thing for an address typed into its search box.

**The servers you quick-connected to before** are listed under the field, one
click each. They were always remembered, but only inside the field's own
dropdown — behind the little arrow nobody presses — so the address you used an
hour ago was effectively hidden. *Forget* drops the list. Only addresses are
kept: an identity path travels with one, and nothing that could be a secret is
ever written down.

**One authentication per host.** Opening a session creates a single
ControlMaster. Every terminal, file operation, tunnel and remote command after
that reuses it. Interactive prompts — password, key passphrase, Teleport MFA —
appear in the connecting pane with an input box, once.

**Two servers side by side, or stacked.** Sessions are tabs, and any tab splits
into panes. `⌘⇧D` / `⌘⇧E` split with the *same* host; `⌘⌥D` / `⌘⌥E` (or
right-click a host → *Open beside current*) split with a **different** one — so
two servers sit next to each other horizontally, or one above the other.

**The tabs say what each session is doing.** Beside the connection dot, three
small bars **ripple while output is arriving** — so the tab running the build
is findable without clicking through the strip. If a session stops at
something that has to be answered — `[sudo] password for…`, a `[Y/n]`, *Press
enter to continue*, an MFA code, or **a coding agent asking permission**
(`Do you want to proceed?` above its numbered options) — the bars give way
to an amber **?** and the tab itself turns amber. That is the one worth going to: it is not
slow, it is waiting for you, and it will wait all afternoon.

Never on the tab you are looking at: the output is already in front of you,
and an animation beside it would only be movement in the corner of your eye.
The marks appear the moment you switch away. Nothing moves in the strip
either — the space is reserved whether or not anything is shown in it, so
tabs and the **+** stay where they are.

Nothing is asked of the shell to work any of this out. Whether output is
arriving is read from the stream on its way to the terminal; whether
something is being asked is read from the **screen**, because a full-screen
program — an editor, a pager, an agent drawing a box — paints by moving the
cursor about, and the end of the stream is whichever line it redrew last
rather than the bottom of what you can see. A question counts only while the
thing asking it is still on screen, so a prompt you have answered, or a log
that happens to contain the words, leaves the tab alone. *Settings → Show
what each tab is doing* turns the whole thing off.

**Panes can be dragged where you want them.** Pick a pane up by its header
and drop it on another pane in the same tab to **swap** the two, on a tab in
the strip to **move it into that tab**, or past the last tab to give it a
**tab of its own**. Drag it clean out of the window and it gets a **window of
its own** — *Move to its own window* in the pane's menu does the same thing
for anyone who would rather not aim. Nothing restarts and nothing
reconnects: the connection and the shell live in the app's core, so the
session, its scrollback and whatever is running come along. A pane handed to
a new window keeps the text that was on screen, and the shell on the far
side never knows it moved.

**Broadcast typing** (`⌘⇧B`) sends your keystrokes to every pane in the current
tab — the "same command on four servers" trick, without scripting it.

**Local shell tabs** (`⌘T`) for when you need your own machine.

**Agent forwarding, compression and X11** are per-connection options, and
**session logging** (`⌘⇧L`) tees a terminal to a file with escape sequences
stripped so the log is readable afterwards.

**Your layout comes back.** The open sessions and their arrangement are saved,
and offered back next launch. Reopening dials real servers, so it is always an
offer — never silent.

## File browser and transfers

The browser speaks **SFTP directly over the multiplexed connection**. It is a
protocol implementation, not a wrapper around the `sftp` command, so filenames
with spaces, exact sizes, permissions and timestamps are all correct.

**Free space comes first in the footer** — *38.9 GB free of 48.3 GB* — for
the volume the listed folder is on, on this machine or the server. It turns
**amber with ⚠** below 20% free and **red with ⛔** below 10%, the point where
a log rotation or a deploy that writes a few gigabytes is a real risk. On a
server it is one `df -Pk` over the connection already open, asked after the
listing so it never slows the files down, and remembered for half a minute
per folder. A host that asks for MFA per session shows no figure rather than
spend an approval on it.

- **Scrollback search** in each pane header, beside the host name: type and
  every match highlights across the whole buffer with a live `3/17` counter.
  `⌘F` focuses it (and picks up the current selection), Enter and Shift+Enter
  step through, Escape clears.
- **Filter by name** (`⌕`, or just start typing with the list focused). Plain
  text matches anywhere; `*` and `?` make it a glob anchored at both ends, so
  `log` finds `mylog.txt` and `*.log` does not. **The arrow keys move through
  the matches from inside the filter box** and Enter opens the one you land on,
  so finding a file is type, arrow, Enter — without clicking into the list.
  Escape clears it. A directory that does not match itself is kept when
  something expanded inside it does, and the status bar always says how many
  entries the filter is holding back.
- **Column headings you can sort by.** A thin strip above the list — *Name*,
  *Size*, *Date*, plus *Mode* and *Owner* when the details columns are on.
  Click one to sort by it, click it again to reverse, and the arrow says
  which is in force. The ⇅ button and its menu still work; this is the same
  sort where everybody expects to click. Ordering is **case-insensitive and
  numeric**, so `Downloads` sits next to `docs` and `node-2` comes before
  `node-10`. Folders always sort before files, and anything that ties on size
  or timestamp falls back to the name so the list never reshuffles itself.
- **Expandable tree.** `+` and `−` open directories in place. Arrow keys walk
  the tree; `←` and `→` collapse and expand. Double-click navigates into a
  folder instead.
- **Go to a path** (`⌖`) jumps straight somewhere — type it, or pick from quick
  places (`/var/log`, `/etc`, `/tmp`, web root, systemd units) and this pane's
  recent directories.
- **It shares the pane with the terminal**, so showing it costs the terminal
  those columns — about 36 at the default width. Drag the divider to change
  the split, or put the explorer **above** the terminal instead (the ▤
  button), which gives the terminal the full width back and takes the height
  instead. Whatever you drag it to is what it reopens at.
- **Two explorers at once.** Each pane independently shows the local machine,
  the focused session, or any other open session — and they arrange **stacked
  or side by side** (the ▤ button).
- **Drag between two servers.** Put one server in each pane and drag. Two
  Teleport nodes on the same cluster hand off directly via `tsh scp` — the bytes
  never touch your machine. Any other pairing is relayed through your machine,
  and ServerLife says which route it will take and asks first. The same is
  available from the context menu as *Copy to another server*.
- **Drag within one pane to move.** Drop a file or folder onto a folder row
  in the same list and it is moved there — a rename underneath, so nothing is
  copied and nothing is at risk however large the folder, on your machine or
  on a server. The pointer shows *move* rather than *copy* so you know which
  it will be before you let go. Two things it will not do: put a folder
  inside itself, and overwrite something of the same name — a clash stops the
  move and says which name it was, because a drag is an easy gesture to make
  by accident.
- **Drag from Finder** straight onto a remote pane to upload. Dropping onto a
  *folder row* targets that folder, not the current directory.
- **Transfer queue** with per-job progress, transfer rates, file counts and
  cancellation — plus an explicit status-bar confirmation naming what finished,
  how much moved and how fast.
- Rename, recursive delete, new folder, and an inline editor for small text
  files.
- **Permissions and owner…** on one entry or a whole selection: an octal mode,
  an owner and a group, with one *Apply to everything inside as well* box that
  makes all three recursive. Blank fields are left alone, an owner and group
  together become a single `chown user:group` while a group on its own becomes
  `chgrp`, and **the exact commands are shown, and update as you type**, before
  anything runs.
- **Details columns.** The **≣** button in the pane header puts permissions and
  owner beside size and date — `drwxr-xr-x`, `ubuntu ubuntu` — and the choice is
  remembered. *Get info…* on an entry adds the numeric mode, the link count,
  the symlink target, every timestamp the server keeps, and, for a folder, its
  recursive size behind a button (walking a deep tree unasked would make every
  right-click expensive).
- **"What do these permissions mean?"** — a button in that dialog that reads the
  mode back in words: what each `rwx` triple grants *this* file, who the owner
  and group actually are, how the octal adds up, and what a `setuid`, `setgid`
  or sticky bit is doing when one is set. It explains the file in front of you,
  not permissions in general.
- **Compare with the other list** (**⇄**) marks both panes at once: what exists
  only here, what is newer on each side, what is identical — with a count of
  each in the status bar. Clearing it clears both panes.
- **Synchronize with the other list…** (**⇆**) walks both trees and shows every
  action before it takes one. Choose the direction (*This machine → server*,
  *Server → this machine*, or *Both ways (newer wins)*), what counts as a match
  (*Size and time*, *Size only*, *Time only*), and whether files the other side
  no longer has are deleted. **Every row has a tick**, so the plan is editable
  rather than take-it-or-leave-it, and the summary says how many files would be
  deleted and how many uploads would overwrite something newer. Uploads carry
  the original modification time, so running it twice does nothing the second
  time. See the [deletion warning](#warnings-and-limitations) below.
- **Synchronize with rsync…** (**⇆**) does the same job with the tool that is
  best at it. The one above walks both trees over SFTP and moves whole files,
  which is right for a handful and wrong for a tree; rsync compares by rolling
  checksum and sends only the blocks that changed, which for "make this 4GB
  directory look like that one" is a different order of magnitude rather than
  a little faster.

  It **rides the connection you already have** — rsync runs itself on the far
  side over a shell of the app's choosing, so it reuses the session's
  ControlMaster: no second authentication, no second Teleport session. It
  therefore needs one to ride, which is why it is offered for ordinary
  Teleport and SSH sessions but not for a per-session-MFA node (every rsync
  would raise its own prompt), a beam, or a bucket; each of those says so
  rather than failing halfway.

  The dialog **opens on a dry run** and the real copy is a separate press with
  the plan already on screen. Source and destination are prefilled from the two
  panes, **⇅ Swap direction** turns it round, and the **☆** beside either path
  offers that side's **starred folders** — the same list the star button shows,
  including a host's defaults like `/var/log`. A path picked from a list is a
  path you have not fat-fingered into a `--delete`. Archive, compress, delete,
  checksum, excludes and any extra flags are yours to set, *Copy the contents
  of the source folder, not the folder itself* is the trailing-slash question
  asked in words, and **the exact command is on screen** — selectable, copyable,
  and precisely what runs. Output streams as it goes, **Stop** ends it, and
  closing the dialog stops the run rather than leaving one going unwatched.

  An old rsync gets a plainer command: macOS ships `openrsync` as
  `/usr/bin/rsync`, which has neither `--info=progress2` nor `-s`, so a
  Homebrew rsync is preferred when one is installed and the flags are trimmed
  to what the binary understands. Any rsync **on your PATH** counts, not only
  one in the usual directories.

  **Not between two servers.** rsync refuses two remote ends outright — *The
  source and destination cannot both be remote* — before it connects to
  either, and there is no flag for it; every workaround is two transfers
  through this machine. Use **Copy to another server…** on the selection,
  which streams them through the app, or sync each server against here in
  turn.

  **Not on Windows.** It says so rather than half-working: there is no rsync
  in the platform to find, Win32 OpenSSH has no ControlMaster for it to ride
  — so the "no second authentication" that makes this worth using is not
  available — and rsync reads `C:\Users\me` as *host C, path \Users\me*, which
  needs translating into whichever convention the installed build uses. The
  synchronise above works there and is the answer until someone can test the
  other properly.
- **Keep this folder up to date from here…** watches a local folder and uploads
  each file as it is saved, new ones included. It never deletes on the server
  and never downloads; `.git`, `node_modules` and editor scratch files are
  ignored. Running watches are listed in the dock's **Watch** panel, and stop
  there or when the session closes.
- **Edit in my editor…** downloads a remote file, opens it in whatever this
  machine uses for that type — or the editor named in Settings — and uploads
  **every save** until you stop it. The local copy is temporary and is removed
  when the watch ends. This is usually the last reason a second file-transfer
  tool stays installed.
- **A download history** in the dock, after the connection log: what you pulled,
  from which host, how big, when, and where it landed, with **Open**, **Show in
  Finder**, *Copy name* and *Copy path*. An entry whose file has since moved is
  greyed and says so instead of failing when clicked, and forgetting an entry
  never touches the file itself.
- **Follow the terminal's directory.** `cd` somewhere in the terminal and the
  browser beside it moves too, within a second: the typed line is watched for
  a `cd`, `pushd` or `popd`, and the pane's directory is read as soon as one
  goes past rather than at the next poll. Anything that route cannot see — a
  command recalled with the up arrow, an alias, a script that ends somewhere
  else — is still caught by the background refresh a few seconds later.
  *Settings → Follow the terminal's working directory* turns the whole thing
  off. It does not apply to sessions opened over `tsh ssh` (per-session-MFA
  nodes, leaf clusters, beams): reading the directory is an exec, and on those
  an exec is another MFA prompt or another line in the audit log.
- **Folders first, or mixed in.** Listings put the folders above the files by
  convention. That is the wrong answer to "what changed here last" and "what
  is the biggest thing in here", so it can be turned off — in *Settings*, or
  from the ⇅ sort menu — and everything then sorts together by whichever
  column is in force.
- **Background refresh.** Every 5 seconds by default, the visible directories
  are re-listed so files created outside the app appear on their own. The
  refresh is non-destructive: it redraws only on a real change and keeps your
  selection, expanded folders and scroll position. Set it to 2/5/10/30 seconds
  or **Off** in Settings — each tick is one SFTP round trip per visible pane.

Transfers are pipelined (16 requests in flight), which on a normal link means
roughly 12–15 MB/s rather than the ~1 MB/s a naive sequential SFTP client gets.

### Controlling the queue

The **Transfers** panel is not only a progress report:

- **Pause and resume**, per transfer or the whole queue. A paused transfer is
  held *between chunks* rather than torn down, so nothing is re-authenticated
  and resuming is instant — and a file dropped in while the queue is held waits
  with the rest rather than starting behind your back.
- **Retry picks up where it stopped.** A download resumes from what is already
  on disk, an upload from what the server already has, so a dropped VPN does
  not mean starting a 4 GB file again. Only on an explicit retry: a fresh
  transfer to a path that exists still means "replace it", and appending to
  whatever was there would quietly produce a corrupt file.
- **Reorder** what has not started yet, for when the small one matters more than
  the big one in front of it.
- **A speed limit** in KB/s across every transfer, because what is being
  protected is the link out of this machine rather than any one copy. One
  allowance, handed out in order — sixteen parallel chunks each claiming
  "2 MB/s" is not a limit anyone meant.

### Searching a whole tree

The filter narrows what is listed; **search** (the magnifier in the toolbar)
walks the folder and everything under it. It answers the question people
actually arrive with — *where on this box is that file* — and works the same on
a server and on this machine.

- **By name.** A bare word matches anywhere in the name, so `nginx` finds
  `nginx.conf`; `*` and `?` work as usual.
- **By content.** Give it a string and it looks inside the files, reporting the
  line number and the line itself. The name box then narrows *which* files, so
  "`*.conf` containing `proxy_pass`" is one search.
- **Clicking a result** shows it in the list with the file selected;
  double-clicking opens it. Right-click for its folder, or to copy the path.

On a server this is `find` and `grep`, with the cap applied by `head` on the far
end so a search of `/` cannot pull a million lines back over the connection.
Locally it is a bounded walk inside the app. Either way it stops rather than
hanging — after six seconds or a quarter of a million entries — and **says
which**, because "no results" from a search that gave up is the wrong thing to
believe.

## Starred hosts and folders

Two stars, for two different kinds of "I come back to this constantly".

**A host's star** is the one on its row in the host list — visible on hover,
filled and amber once set. Starred hosts are listed again, together, in a
**Starred** group at the top of the list. They stay in their own cluster's
group as well, marked with the star: moving them out would leave a cluster's
list quietly incomplete, which is worse than naming a host twice. The group is
collapsible and can be dragged elsewhere like any other; drag it and it stays
where you put it.

**A folder's star** is the one in an explorer's toolbar (**☆**), and it applies
to the folder on screen. Starred places are listed as a **starred** section
above the file list — name, where it is, and highlighted when you are in it —
which collapses by its heading when the files are what you came for. The same
list appears in *Go to a path* (`⌖`).

**Files can be starred too.** A starred folder is somewhere to go and opens on
click; a starred file is something to open, and clicking it does that — handed
to the OS locally, opened in the built-in editor on a server. *Star this
file* / *Star this folder* is on any row's right-click menu, so neither has to
be opened first.

Right-click the toolbar star for the scope:

| | |
|---|---|
| **this machine** | a local folder — `~/Downloads`, a repository you live in |
| **this host** | a folder that only means something on one server — an app's deploy directory |
| **every host** | the same question everywhere — `/var/log`, `/etc/nginx` |

Per-host stars are kept against the host's uuid where there is one, so renaming
a Teleport node does not lose them.

### What gets starred without being asked

Some folders are flagged from the start, so the list is useful before anyone
has starred anything: your home, Desktop, Documents and Downloads here, and on
a server the same plus `/var/log`, `/etc` and `/tmp`.

Both lists are configurable in Settings — one path per line, `~` for the home
directory of whichever side it applies to. Two things keep them honest:

- **Nothing that is not there is offered.** A local path is checked before it
  is listed, and a `~/name` entry on a server only appears on hosts that
  actually have that folder — the home directory is listed once per connection
  to find out. A cloud instance is therefore not offered a Desktop it does not
  have.
- **They live in code, not in your settings**, the same arrangement the
  built-in macros use: they improve between releases, and *Hide this one*
  hides one without editing a list you never wrote. *Restore the built-in
  ones* brings them all back.

---

## Folders in the host list

A cluster's list is whatever `tsh ls` returns, in whatever order. On a real
fleet that is several hundred rows in which the fifteen you actually work on
are scattered. Stars help and stop at one flat list; the filter box helps and
is something you retype. Folders are the other answer: a name, a place to drag
a machine into, and it stays there.

Every cluster and every ssh_config file can have its own folders. Right-click
a group's heading → **Folders → New folder…**, or press **Folders** above the
list for the big view.

A folder you close stays closed — and so does a cluster or config file's group
— across restarts, so the list opens the way you left it.

### Two ways in

**By hand.** Drag a host onto a folder. It is kept by the node's **UUID**,
never its hostname — a hostname changes on a rename or a rebuild, and a
filing system that empties itself when somebody renames a box is not one.
An ssh_config host is kept by its alias, which is the same thing for a host
that has no uuid.

**By rule.** Give the folder a tag query and it fills itself, re-asking every
time the inventory changes, so a node that comes up tagged `env=prod` files
itself without anyone touching it. The rule is written when the folder is made
or edited, and the dialog says how many hosts it matches *right now* and names
the first few, because a rule that matches nothing is easy to write and hard
to notice.

A folder can use both at once. A host in a rule folder shows a **by rule**
badge in the big view, and taking one out is remembered as an exception —
otherwise the rule would put it straight back, which reads as the app ignoring
you.

### Once something is filed

**It stops being listed loose.** A filed host is listed inside its folder and
nowhere else in that group, because the point of filing something is that it
is now somewhere. *Folders → Also list filed hosts at the top* puts them back
in both places if you would rather see the whole cluster flat as well.

**Folders nest**, as deep as you like. Drag a folder onto another folder to
move it; a folder cannot be dropped inside itself or inside its own
descendant, and the cursor says no rather than the app explaining afterwards.

**Dragging a host into a folder under a different top-level folder asks**
whether to list it in both or move it. Both answers are ordinary — the same
box is one of the web servers *and* one of the things on call this week — so
it is a question rather than a guess. Dragging between two folders of the same
tree is a tidy-up and moves it without asking.

### The big view

The pane's cluster list includes **leaf clusters**, each shown as
`root › leaf`. Picking one reads that leaf with its own `tsh ls` and lists
its nodes — a question, not a switch: the profile stays pointed where it is,
and the sidebar is unchanged. A leaf whose proxy will not answer says so
rather than looking empty.

**Folders** (above the host list, or a group's *Folders → Open the folder
browser*) opens the same folders with room to work in: the tree on the left,
what is in the selected folder on the right, breadcrumbs across the top, and
an **Unfiled** entry per group which is where the filing gets done. It is a
file manager, so it behaves like one — click, ⌘-click and shift-click to
select, drag a selection onto any folder in the tree, double-click a folder to
go in or a host to open a session on it. A folder's rule is shown above what
it currently claims, with the *Edit rule* button beside it.

### Boolean rules

Folder rules — and the host filter box, and multi-exec's tag selector — take
`and`, `or`, `not` and brackets, on top of the older syntax where a space
means "and" and a leading `-` means "not":

| Query | Matches |
|---|---|
| `env=prod role:web` | both, as before |
| `env=prod and role:web` | the same, said out loud |
| `env=prod or env=staging` | either |
| `not env=dev` | the same as `-env=dev` |
| `env=prod and (role:web or role:api)` | brackets group |
| `env=prod and not name=web-canary` | everything in prod except that one |
| `"or"` | quoted, it is a word to search for again |

`and` binds tighter than `or`, so `a or b and c` reads as `a or (b and c)`. A
half-written query is not an error: while you are still typing, the filter
falls back to reading the words as a plain list of conditions rather than
blanking the list. A folder's rule dialog does say what the parser made of it.

### Names and patterns, not only tags

A rule does not have to be about labels. Anything the host list knows can be
matched — `name`, `hostname`, `addr`, `cluster`, `proxy`, `type`, `user`,
`uuid`, `tunnel` — and three ways to say it:

| Query | Matches |
|---|---|
| `name=web-01` | exactly that |
| `name=web-*` | a glob |
| `name:web` | contains |
| `name~^(web\|api)-\d+$` | a **regular expression**, case-insensitive |

`~` is the regex operator. It is there because a glob runs out quickly — "the
numbered web and api boxes but not the canary" is one pattern and several
globs — and because the brackets in a pattern are the pattern's own: `name~^(web\|api)$`
is one condition, not a group. A pattern that will not compile is
reported in the rule editor rather than quietly matching nothing.

**A label never hides a field of the same name.** AWS nodes carry an
`aws/Name` tag, whose last segment is `name`, and `name=` used to ask about
that tag and never about the node's own name — so `name=prd-web01-linux-ec2`
matched nothing on the one host it obviously described. Both are asked now,
and either matching counts.

### Writing one without knowing the vocabulary

The hard part of a rule is never the syntax, it is knowing what *this* cluster
calls things: `tsh ls` decides the labels, and every cluster's are different.
So the folder dialog does not ask you to remember them.

- **Insert a tag…** lists every label the group actually sets, with how many
  nodes carry each value. Picking one drops `key=value` into the rule.
- **Insert a field…** does the same for the non-label ones, including the
  regex and glob forms of `name`.
- **and / or / not / ( )** are buttons, and an `and` is put in for you between
  two conditions that have nothing between them.
- **What it matches right now** is under the box as you type: the count, and
  every matching host by name.

### Icons and colours

A folder can carry an **emoji and one of the eight host colours** — the icon
because 🔥 and 🧪 are read faster than two folder shapes with different names,
the colour because it is the same mark its hosts can carry, so a red folder
and a red host match.

**Hosts can carry an emoji too** — right-click one → *Give it an icon…* — and
that includes ssh_config hosts. It is separate from the host's colour on
purpose: the colour is "careful", the icon is *which* of these it is. A red 🐧
and a red 🪟 are both production and not the same problem.

A saved profile carries the same two marks, from its own *Mark this
profile* menu.

### Sharing an arrangement

*Folders → Export these folders…* writes the whole arrangement — the tree, the
rules, the membership, the icons and colours — to a JSON file, and *Import
folders…* reads one back. No addresses, no logins, nothing secret: it is a way
of looking at a cluster, and it is safe to put in a pull request.

Membership travels as UUIDs, so a colleague importing your file gets the same
machines in the same folders on the same cluster. Rules travel anywhere, since
a rule means the same thing on any cluster — which is why the import offers to
land a file from a cluster you do not have into one you do. Imported folders
are given new ids, so importing the same file twice makes a second copy rather
than quietly overwriting the folders you have since edited; *replace* is there
when overwriting is what you meant.

---

## What a host remembers

These settings live on a host rather than in Settings, all of them on its
right-click menu in the host list.

**Preferred username.** *Preferred username…* pins the account this host is
always opened as. This is a decision, and it outranks the login the app
happens to have learned — which is otherwise whatever worked last. It is
stored against a Teleport node's **uuid**, not its name: the hostname in an
inventory is a label that changes when a machine is renamed or rebuilt, and a
setting that evaporates on a rename is worse than no setting. A username that
is not one of the cluster's principals is still honoured; the cluster decides
whether it is allowed, and silently substituting a different account would be
worse than failing.

**Startup command.** *Startup command…*, right below it, runs a command the
moment a session on this host opens — the same thing a saved profile's own
startup command already does, for a host nobody has saved a profile for.
Stored against the same key as the preferred username, so it survives a
rename too.

**Whether it opens with the file browser.** *Opens with the file browser*, just
below *Preferred username…*, decides whether a new session on this host shows
its files beside the terminal. Some hosts are a shell and nothing else — a jump
box, a router, an appliance with no SFTP subsystem at all — and on those the
explorer is half a pane spent on an error message; others on the same cluster
are entirely about the files. The same three levels as agent forwarding: this
host, then the cluster (also on the group heading's menu), then the global
preference — which is simply how you last left the show/hide-all-explorers
toggle. Asking for the files outranks all of it —
⌘E still opens the explorer, and *Open files only* still opens a host flagged
against them.

**Agent forwarding.** Forwarding your agent (`ssh -A`, `tsh ssh -A`) lets
anything running as root on that host use the keys in your agent for as long as
the session is open. That is exactly what a jump host needs and exactly what a
shared box should not have, which is why it is worth deciding per host. Three
levels, most specific first:

1. **This host** — on, off, or *follow the cluster*.
2. **The cluster** (or all ssh_config hosts) — on, off, or *follow the global
   preference*. On the group heading's menu.
3. **The global preference** — in Settings. Off by default.

Every route into a connection obeys the same three levels — a double-click, a
saved profile, multi-exec, an agent through MCP — because the answer is resolved
where the connection is made rather than in the button that asked for it.

**Whether to be told if it disappears.** *Tell me if this host disappears*
keeps the node's id and last known details, and marks the row **⊘ gone**
instead of letting it silently stop being drawn. See [Hosts that disappear
entirely](#hosts-that-disappear-entirely).

**An icon.** *Give it an icon…* puts an emoji beside the name, in the host
list and in the folder browser. Any host can have one, an ssh_config alias
included, and it is kept against a Teleport node's uuid like everything else
here. Separate from the colour below because they answer different questions:
the colour is "careful", the icon is *which* of these it is.

**A colour.** *Give it a colour…* marks a host in one of eight colours, drawn as
a bar down its row in the host list, its tabs and its panes, with the name
tinted to match. Not decoration: it is how you know the pane you are typing into
is production without reading it. The same menu can mark a host **careful**, and
multi-exec then asks before a command fans out to it — which is the case the
colour exists to prevent.

### The same two marks, for a whole cluster

Six clusters in a sidebar are six lines of near-identical grey text —
`teleport-b.example.com` against `teleport.example.com` — and the one you
must not fat-finger a command into looks exactly like the lab. **Right-click
a cluster heading** in the host list, or **a cluster's row in the Teleport
tab**, for *Give the cluster an icon…* and *Give the cluster a colour…*, from
the same emoji picker and the same eight colours a host or a folder uses.

The icon sits **before** the name — a heading is read rather than scanned down
a column — and the colour tints the heading and draws a bar down the group's
left edge, the same bar a coloured host row wears, so a red cluster and a red
host inside it read as one statement. Both marks appear in **both** lists, and
the icon rides along in the hosts pane's cluster picker.

They are filed against the cluster's **group key**, not its name: the same
cluster reached through two tsh homes is two rows, and they are not
interchangeable.

---

## Keyword highlighting

Reading a log in a terminal is mostly looking for four or five words.
Highlighting colours them as the output arrives, so `error` is visible without
searching for it.

**It is off until you turn it on** — colour in a terminal belongs to the
program, and rewriting its output is a decision worth making rather than one
that arrives. Turn it on for everything in Settings, or for one host with the
toggle beside that pane's search box (**▤**), which is lit whenever it is
doing something. Right-clicking that toggle opens the rules.

Three sets are ready to go, because they are the words people are actually
looking for:

| | |
|---|---|
| **Errors** | error, fatal, critical, panic, traceback, denied, refused, failed, cannot, unable to |
| **Warnings** | warn, deprecated, timeout, timed out, retrying, degraded, throttled |
| **Good news** | success, succeeded, active (running), healthy, ready, completed, enabled |

They live in code rather than being copied into your settings, so they improve
between releases. Editing one copies it into your settings under the same id,
where it replaces the original; hiding one leaves it hidden until *Restore
built-ins*.

Your own rules take plain text or a regular expression, a colour, and whether
to fill the background or colour the text. A rule can be added for **one host
only** — a mail relay's "deferred" is routine, a build box's is not — and any
rule can be switched off for one host without touching what the others do.

Two things worth knowing about how it works. It rewrites the byte stream on its
way to the terminal, wrapping matches in colour and putting back whatever
colour the program had set, so highlighting a word inside a red line leaves the
rest of that line red. And it **stands aside entirely while a full-screen
program is drawing** — vim, less, htop, top — because those paint their own
colours and a highlighter recolouring an editor's buffer is vandalism rather
than help. Highlighting applies to new output only: what is already on screen
was written with whatever was in force at the time, and repainting it would
mean replaying the session.

---

## Local shells

Double-clicking **Local shell** opens your login shell. Its right-click menu
has two more things.

**A new local shell starts where the last one left off.** Close a shell that
had `cd`'d into a project and the next plain *New local shell* (`⌘T`, the +,
the menu) opens in that same folder rather than back at home. Anything that
names its own folder — a saved profile, a restored layout — still wins. It is
remembered for as long as the app is running, not across a restart.

**The + above the tabs opens one too.** The new-session picker lists *This
machine* between your recent sessions and the inventory: your login shell
first, then every other shell installed here. A local shell was always in that
list, but below the last of however many hundred hosts, which is not somewhere
anyone finds it. Right-clicking the + still goes straight there, and `⌘T` skips
the dialog entirely.

**Open another shell** lists the shells actually installed on this machine —
read from `/etc/shells` and the usual Homebrew and system paths, filtered to
what exists and is executable. Useful for the "what does this look like in bash
rather than my zsh" question.

**Open with a blank configuration** starts a shell that reads no startup file
at all: `bash --noprofile --norc`, `zsh -f -d`, `fish --no-config`. Worth having
for two quite different reasons — reproducing what a *script* sees, with none of
the aliases, prompt or PATH your rc file adds, and getting a working shell when
an rc file is what just broke. A blank shell is deliberately not a login shell,
since `-l` is what reads the profile being avoided, and it carries
`SERVERLIFE_BLANK_SHELL=1` so a prompt can tell.

---

## tmux

<a id="tmux"></a>

A host's right-click menu has **Open in tmux…**, and that one choice changes
what a session *is*: the work stops belonging to the connection. Close the
lid, lose the wifi, quit the app by accident — the shell on the far side is
still running, with its scrollback, waiting. Reattach and it is where you left
it.

Only the server needs tmux. Nothing is installed on this machine: ServerLife
speaks tmux's control protocol itself, over the connection that is already
open — the same authentication, the same ControlMaster, the same single MFA
tap. A host without tmux says so, and names the one command that fixes it.

**It looks like the rest of the app.** A tmux window is a tab, a tmux pane is
a pane, and the arrangement is the one tmux reports — split a pane here and
tmux is asked to split, so another client looking at the same session sees it
too. The file browser is there as on any other session, reading the server
over the same connection, and following the shell as it moves. Search,
keyword highlighting, macros, saving the buffer and dragging a pane to another
tab all work exactly as they do elsewhere.

### Making it the default

On the host's menu, **Open in tmux: …** sets it three ways, as agent
forwarding and the file browser are set: for this host, for every host on the
cluster, or everywhere (also in Settings). With it on, **Open session** means
tmux and the menu offers **Open without tmux** for the one time you want a
plain shell. The session name is `serverlife` unless you change it — globally
in Settings, or per host from the same menu, which is how you keep separate
sessions for separate jobs on the same machine.

### Attaching, detaching, ending

**Open in tmux…** lists what is already running there and offers to start
something new. Picking the wrong one is the only mistake here that looks like
data loss — your work is not gone, it is in the session you did not pick — so
it asks rather than assuming.

A pane's right-click menu has **Detach — leave it running**, which is what
closing the tab does too, and **End this tmux session…**, which is the only
action here that destroys work and says so.

**Closing a pane closes it in tmux too** — its ✕, `⌘W`, *Close pane (in tmux
too)* — and tmux's next layout takes it off the screen, so the app and tmux
never disagree about what is left. Closing the session's last pane ends the
session, so that one asks first. *Close the view (keep it running in tmux)* on
the pane's menu only stops showing it.

When a session ends, the pane says so over what it was showing. **Show
terminal** moves that notice into a bar along the top, so the last screen can
still be read and copied; **Show notice** puts it back.

### What it costs

Two things are worth knowing. tmux must be installed on the far side, which
is one `apt install` and nothing on this machine. And Teleport records a
control-mode session as the protocol stream rather than as a readable
terminal, so `tsh play` of that session shows the protocol, not what you saw
— every attach is still audited and recorded, but the recording is not
watchable. That is why this is off by default and set per host: on the
machines where a dropped connection costs an afternoon it is obviously worth
it, and those are not usually all of them.

### Why tmux, and not screen

The two look interchangeable from a plain terminal, so it is a fair question
why only one is built in. The answer is not preference — it is that this
feature does not exist for screen to support. Everything above hangs off
tmux's control mode (`tmux -CC`), a line-based protocol where tmux reports
its own panes, windows and layout as structured events rather than drawing
them; that is what lets a tmux pane become a ServerLife pane instead of a
picture of one. Screen has no equivalent. Its only scripting surface is
`screen -X <command>`, fire-and-forget with no reply, and `screen -ls`, a
session list with nothing about what is running where. There is no layout to
read and no event to map onto a split here, so the deepest a screen
integration could ever go is attaching to it as a plain shell — which costs
nothing to do by hand already: a host's startup command set to `screen -DR`
reattaches (or starts) a named session on connect, no different from typing
it.

It also reflects where each project actually is. tmux is developed
continuously — new terminal and clipboard support, ongoing releases. Screen
last cut a release in 2022 after a long gap before that, and macOS froze its
bundled copy years ago rather than keep updating a GPL tool, the same reason
its bundled bash is still stuck on 3.2. Nothing there is broken, but nothing
there is being built either.

---

## Consoles and screens

<a id="consoles-and-screens"></a>

Four more things you can save and open, beside SSH hosts and Teleport nodes
and in the same folders: a **serial console**, a **telnet** session, a **VNC
screen** and a **Remote Desktop** connection. They are in **New profile…**
under Type, and they open the way everything else does — double-click in the
Saved list, or find them in the `+` picker.

They are here because of what they are for. The machines that answer only on a
console cable or on port 23 are switches, routers, PDUs, BMCs, terminal servers
and appliances — the things you reach for *when SSH is what has stopped
working*. A tool for looking after servers that cannot talk to a console is a
tool that leaves at the moment it is needed.

None of them is a connection in the sense the rest of this guide means. There
is no ControlMaster, no SFTP, no port forwarding and no second channel: a
serial port is one stream of bytes with no multiplexing in it at all. So these
panes have no file browser and no network tools, and everything else — splits,
dragging a pane to another tab or its own window, search, keyword
highlighting, macros, saving the buffer to a file — works exactly as it does
on a shell.

### Serial consoles

The port can be picked from **Ports on this machine now**, which lists what is
plugged in as you fill the form, or typed — a saved console should not require
the cable to be attached when you create it.

Speed, data bits, parity, stop bits and flow control are the usual settings
and default to **115200 8N1**, which is what almost everything made this
century uses. Hardware flow control on a console cable with no CTS wire looks
exactly like a dead port, so it is off unless you ask for it.

**Enter sends** is worth knowing about. Nothing agrees about what Return
means: xterm sends CR, most network gear wants CR, a Linux getty usually wants
LF, and some appliances insist on CRLF and show you a staircase if they do not
get it. Guessing wrong gives you a console that looks dead or one that
double-spaces everything, and both get blamed on the cable.

**Show what I type** echoes your keystrokes locally, for a device in its boot
loader or a port with nothing on the other end yet — which otherwise shows
nothing at all as you type, and is indistinguishable from a broken lead. When
the far end echoes too you will see everything twice, which is why it is off
unless asked for.

The pane's right-click menu has **Send break** — a long break on the line,
which is how you interrupt a boot loader and the reason the option exists at
all.

A port that is already open elsewhere, or that you have no permission for,
says so in those words: "in use by something else — screen, minicom or another
window", and on Linux "add yourself to the dialout group".

The `+` picker also lists the serial ports present right now under *This
machine*, openable at 115200 8N1 without saving anything. A console cable is
usually wanted five seconds after it is plugged in and for one look at a
switch that will not boot, which is not an occasion for filling in a form.

### Telnet

Host and port, and the same **Enter sends** and local echo settings — the
default here is CRLF, which is what telnet's own NVT specifies.

The protocol negotiation is handled: the terminal type is reported as
`xterm-256color` when asked, the window size is sent and re-sent as the pane
is resized, and a server offering to echo is taken up on it. None of that is
visible, which is the point.

### VNC screens

Drawn in the pane, not handed to another application. Host and port — 5900 is
display `:0`, 5901 is `:1` — and three settings: whether to **scale** the
screen to the pane, ask the **server** to match the pane, or show it full size
and scroll; the picture quality; and **view only**, for watching something
without the risk of clicking in it.

The password is asked for when you connect and is **not** saved. ServerLife
keeps its settings in a plain file, and a VNC password in one is a VNC
password in every backup of it.

The right-click menu sends **Ctrl+Alt+Del**, which no browser will let through
by itself, and pastes the local clipboard into the session.

A VNC server usually listens only on localhost. If yours does, open a tunnel
to it from **Tunnels** on the host that can see it, and point the connection
at `127.0.0.1` and the local port.

### Remote Desktop

RDP opens in **this machine's own client** — Remote Desktop Connection on
Windows, Windows App (formerly Microsoft Remote Desktop) on macOS, FreeRDP or
Remmina on Linux — with the settings from the saved connection written into
the file it reads.

This is the one protocol here that is not drawn in the app, and the reason is
worth stating rather than hiding. RDP is not a screen protocol with a keyboard
bolted on; it is a bundle of virtual channels — printers, drives, smart cards,
audio, clipboard, RemoteApp, multi-monitor — and a viewer that implements the
drawing orders and none of the rest is a demo, not something to work in. What
is worth keeping is the *settings*, which is the part people retype: the
address, the user and domain, the window size or full screen, the gateway, and
which redirections are on. Those live here, in the same list and the same
folders as everything else.

---

## Saving what you are looking at

- **A terminal.** Right-click a pane → *Save this terminal to a file…* writes
  everything in its buffer, scrollback included, as plain text. *Copy
  everything* does the same to the clipboard. Colours are escape sequences, so
  they are dropped: a file full of them is worse than useless in every other
  tool.
- **A network tool's output.** *Save output…* in Network and certificate tools writes the last
  result — the text for ping and traceroute, the JSON for DNS, ports, TLS and
  `/webapi/ping`, the response body for a curl call — with a filename already
  shaped from the target.
- **A multi-exec run.** *Save results…* on a finished run writes every host's
  output as YAML, and *Save YAML…* saves the command and host selection to run
  again later.
- **The guide.** *Save as a file…* in Help → Guide, or *Copy the whole guide*.

---

## Adding servers

`⌘⇧N`, or **+ Add** in the sidebar footer, defines a server that is not in your
config yet — hostname, user, port, key, jump host and any extra `ssh` options —
with a **Test connection** button that dials it once and reports what answered
before you commit.

Two destinations, and the dialog is explicit about the difference:

- **Write to `~/.ssh/config`** — the host becomes available to `ssh`, `scp`,
  Ansible and everything else on the machine. Entries go inside a marked
  ServerLife block; your own configuration is never reformatted or reordered, a
  backup is taken first, and it refuses to shadow a `Host` you defined yourself.
  Right-click → *Remove from ~/.ssh/config* takes it out again.
- **Save in ServerLife only** — the connection details ride on the `ssh` command
  line instead. Nothing else on the machine learns about the host.

### A standalone SFTP server

**New profile…** has its own **SFTP (standalone server)** type for the same
kind of host as *Save in ServerLife only* above — hostname, port, user, an
optional key — reached from the profile editor instead, and opening straight
into the file browser by default rather than a terminal (*Open with a
terminal*, on its menu, is the way back to one).

There is deliberately no password field: ServerLife keeps its settings in a
plain file, and a stored password in one is a password in every backup of
it. Leave the private key blank and it is asked for on connect, the same as
any other password-only host — and every *other* key is skipped too, so a
dedicated SFTP account's sshd does not exhaust its `MaxAuthTries` on keys
from the agent before the password prompt is ever reached.

It is a profile like any other after that: folders, a colour and an icon,
split beside or below the current pane, and — being an ssh connection under
the covers, unlike the four consoles and screens below — the full file
browser, not a stripped-down one.

### Editing ssh config from the host list

Right-click any ssh config host — one you wrote yourself, not only one
ServerLife added:

- **Delete or comment out in ssh config…** shows the host's block as it is in
  the file, then offers *Comment out* (every line kept, prefixed with `#`, to
  restore by hand) or *Delete* (the block and the comment lines directly above
  it, which the list shows as its description). The file is copied to
  `<file>.serverlife-backup` first — over the previous one, so it is always the
  state before the most recent edit. On a `Host` line that names several hosts,
  only that one name is taken off and the block stays for the others.
- **New host in this config…** opens *Add a server* writing to the file that
  host came from, so a host belonging in an extra config file lands there
  rather than in `~/.ssh/config`.
- **Edit its ssh config…** opens the file here, colour-coded — `Host` and
  `Match` lines, option names, values, comments, and an option name ssh would
  not recognise underlined as you type — with **suggestions** on the
  right: a Host block to fill in, a jump host, defaults for every host, a
  port forward, an `Include`, and every common option below in ssh_config's
  own `Name value` form — each with *Copy* and *Insert at cursor* (`Tab`
  indents two spaces). *Check* and *Save* have `ssh -G` parse the text first,
  the way a real connection would: a bad line is shown with its number and
  nothing is written. Saving keeps the previous file as
  `<file>.serverlife-backup`, with its permissions, and re-reads the host list.
  *Open in external editor* is still there.

The same *New host in this config…* and *Edit this ssh config…* are on each
config file's heading.

**Common ssh options** sit under every *Extra ssh options* box — a new host,
an SFTP profile, a host's own SSH options — and under **SSH options** on an
SSH or Teleport profile, where they are added on top of the host's own when
the profile opens (the profile's line wins for the same option). Pick one to add it (or type your
own): *Use only this key file…* (asks for a `.pem` or `id_*`, and adds
`IdentityFile` with `IdentitiesOnly yes`), *Offer only the keys named here*,
*Offer no SSH keys at all*, *Don't use the SSH agent*, *Password login only*,
*Forward my SSH agent*, keep-alives, a connect timeout, compression, host-key
handling and legacy `ssh-rsa`. An option already in the box is replaced, not
repeated. *Use for new hosts by default* makes what is in the box the
starting point for every new host and profile.

### Putting an SSH host behind Teleport

Each time you open a session on a plain SSH host, ServerLife checks whether it
has a Teleport agent — again every session, so a host that has had Teleport
installed or removed since is seen as it is now (Settings →
`detectTeleportOnSsh` turns the check off; so does *No background commands on
servers*). Clicking ⚡ asks again first, and after *Run in this session* the
check repeats for a few minutes, so the button goes away once the install has
landed. One that
does is tagged **⚡ Teleport detected**. One that doesn't gets **⚡ Add to
Teleport** on its row, a ⚡ button in its session's pane header, and — the first
time — a notice with *Add to Teleport…*. Each opens **Install Teleport on this
host**:

- **Join this Teleport cluster** — one you are logged in to.
- **Node name** — how it will appear in `tsh ls`; starts as the host's alias.
- **Labels** — `key=value`, one per line; what roles and search match on.

*What will run* shows the commands as you type, with a placeholder token:

```
curl -fsSL https://<proxy>/scripts/install.sh | sudo sh
sudo teleport node configure --output=file:///etc/teleport.yaml --proxy=<proxy>:443 --token=<token> --node-name=<name> --labels=<key=value,…>
sudo systemctl enable --now teleport
```

The first line is the cluster's own installer, with that cluster's version
written into it; it installs through `teleport-update`, so the agent keeps up
with the cluster afterwards. **Copy command** makes a real `node` join token —
on the cluster picked, checked to be that cluster, valid for an hour — and
copies the commands with it. **Run in this session** types them into the
host's own terminal, so `sudo` can ask for a password there. The host needs
Linux with systemd.

## Running one command

Right-click a host → **Run a command…** for the questions that do not justify a
session: is it up, what version, is the disk full. It runs over the shared
connection, shows stdout, stderr, exit status and duration, and offers to save
the command as a snippet or copy the output. **Run as** says which account it
will run as — the host's preferred login, or any other from the list — and an
open session is reused only when it is that account. For the same question
across many hosts, use multi-exec.

A node that needs per-session MFA prompts right there instead of failing —
see **Per-session MFA**. **Recent…**, beside the command box, remembers what
was last run here, separate from a snippet: nothing has to be named or
deliberately kept for it to be offered again.

## Command snippets

`⌘⇧C` opens the snippets library: the commands you repeat, saved once.

- **Run here** sends one into the focused terminal.
- **Run in all panes** sends it to every remote pane in the tab.
- Select text in a terminal and right-click → *Save selection as snippet*.
- The list orders itself by how often you actually use each one.

Saved profiles also carry a **startup command** and remote/local start
directories, run automatically when that profile opens.

## Fleet operations

**Multi-exec** runs one command across many hosts at once. Tick hosts in the
sidebar, press `⌘⇧M`, type a command. Each host runs over its own connection,
concurrently; results stream back per host with stdout, stderr, exit code and
duration. A dead host reports its error without blocking the others.

With two or more hosts ticked, any host's right-click menu also has **Open
multi-exec on N selected hosts…**, and — where some of them are only
requestable — **Request access to N selected nodes…**, which starts one
request per cluster the selection spans. **Clear selection (N)** appears after
*Folders* at the top of the list while anything is ticked.

- **More than one line.** The command box grows as you write: `Enter` runs,
  `Shift+Enter` adds a line, and the lines go to each host as one script.
- **Run as** names the account on every host; empty, each host uses its usual
  login. A session already open as someone else is not reused for it.
- **The targets are listed** one host a row — its name, the account, its
  cluster and its first few tags — and **×** leaves one out: a ticked host is
  unticked, one matched by a tag query or an open session is set aside until
  *put back*.

### Staged rollout and retries

Under **Advanced**:

- **Run in stages** — automatically above ten hosts, always, or never. The
  first stage is a canary of so many hosts, then batches of so many; between
  stages the run can pause for a look (*Next stage*, *All the rest*, *Stop
  here*) and stops by itself at a stage with a failure.
- **Retry a host that fails** so many more times, so many seconds apart. A host
  that could not connect is dialled again too. Each result says which try it
  ended on, with what the earlier tries said above its output, and only how it
  ended counts — for a stage, and in the totals. Cancelling stops the waiting
  as well.

Both are saved with a YAML run, and a loaded file's settings apply until they
are changed by hand.

### Scheduling

**Schedule…** beside *Run* keeps the command, the run-as account and the hosts
— the ticked ones, by id, or the tag query, asked again at each run — and runs
them at a date and time:

- **Once**, or **every** so many minutes, hours, days or weeks. Days and weeks
  are counted on the calendar, so 09:00 stays 09:00 when the clocks change.
- **Ending** never, after a number of runs, or on a date. The dialog previews
  the next few runs as you set it up.
- **Its own retries and staging.** A scheduled run never pauses between
  stages — nobody is there to press *Next* — but still stops at one that fails.
- **A host marked careful** is confirmed when the run is scheduled, since
  nobody will be asked when it runs.

The **Scheduled** tab lists every schedule with its next run, its last result,
and *Run now*, *Pause*/*Resume*, *Edit* and delete. A scheduled run does not
touch the form or your ticks; it says when it has finished, outside the window
too when the window is not in front.

Schedules run **while ServerLife is open**, in the first window, in local
time. One that fell due while ServerLife was closed is **not run late** — a
change made at the wrong hour can be worse than none — but counted as missed
on the tab, and the next one is waited for.

**Save runs as YAML.** *Save YAML…* writes the command and its host list to a
readable, diffable file; *Load YAML…* restores both and re-selects the hosts.
Finished runs export their results as YAML too.

```yaml
kind: serverlife.multiexec
name: Check disk usage
command: |
  df -h /
  uptime
targets:
  - type: teleport
    name: example-cluster
    cluster: example-cluster
    login: ubuntu
  - type: ssh
    alias: ent
```

**Ansible export** turns that same selection into a runnable bundle:

```
serverlife-ansible/
├── inventory.yml      # hosts grouped by cluster, with the right proxy settings
├── playbook.yml       # your command as a task
├── ansible.cfg
├── ssh_config/        # generated tsh config so Teleport nodes resolve
├── run.sh
└── README.md
```

Use it when an ad-hoc command turns out to be something you will run again.

### Choosing targets by tag

Ticking hosts says *these eleven*; a tag says *whatever matches*, which is the
instruction people actually have — "every prod web node" — and it does not go
stale when a node is added. Tick **Choose by tag instead of ticking hosts**,
pick a cluster (or all of them) and write a query in the same syntax as the host
filter: `env=prod role:web`. The panel says how many match right now.

The query is what a saved run keeps, so a YAML saved today runs against next
month's fleet; the hosts it matched go in as a commented snapshot so the file
still says what it meant. **Run again** on a remembered tag run re-asks the
question rather than repeating the answer. The **Ansible export** resolves it
first — an inventory is a list of machines — and names the query in the play.

### Recent runs

Every multi-exec is remembered: the command, the hosts it ran on, how many
succeeded and when. **Run again** re-selects those hosts and runs the same
command; **Edit** puts the command back in the box without running it.

What is kept is the *question*, not the answers — the results are long and go
stale immediately, while "the same thing again after the fix" is the most
common follow-up, and the tedious part of that is never the command but
re-ticking eleven hosts. Hosts are matched by id rather than name, so a renamed
Teleport node still matches; if some of them have genuinely gone, it says how
many are left and asks before running on a smaller set than you asked for.

---

## Port forwarding

Right-click a host → **Port forward…**

| Type | Flag | What it does |
|---|---|---|
| Local | `-L` | A port on your machine reaches a service the server can see |
| Remote | `-R` | A port on the server reaches a service your machine can see |
| Dynamic | `-D` | A SOCKS5 proxy that exits through the server |

Tunnels are created on the **existing** connection (`ssh -O forward`), so they
need no new authentication and can be opened and closed while sessions stay up.
The *Tunnels* panel lists them with a one-click copy of the local address.

### Favourite tunnels

A tunnel dies with its session, and the interesting ones are the same three or
four every day — the database on its private address, the admin UI that only
listens on localhost. Retyping `5432 → 10.0.4.12:5432` from memory is how a
client ends up pointed at the wrong replica.

The **Tunnels** panel therefore has a Favourites section above the open ones:

- **Star an open tunnel** to keep it. The moment you know a tunnel is worth
  having again is usually after something has connected through it, not while
  typing the ports in.
- **Tick "Keep this as a favourite"** in the port-forward dialog, and name it.
- **+ New…** defines one without opening anything — pick a host, a type, the
  ports, and an account if it needs a particular one.

**Open** puts a favourite back up, dialling its host first if it is not already
connected. A favourite stores the host *whole* rather than by id, because it has
to outlive the inventory it was made from: log out of the cluster and back in,
restart the app, and it must still know what to dial. A favourite already up is
marked **open** rather than offering to open a second copy on the same port.

---

## X11 forwarding

Right-click a host → **Open with X11 forwarding** to run `xeyes`, `xclock`,
graphical installers and the like. Works over Teleport and plain SSH. Choose
untrusted (`-X`) or trusted (`-Y`) in Settings.

On macOS this needs [XQuartz](https://www.xquartz.org/). ServerLife checks for
a local X server first and tells you what is missing rather than letting the
program fail with `cannot open display`.

> Teleport nodes must also allow it: the role needs `permit-X11-forwarding`,
> and the node needs `X11Forwarding: yes`.

## Per-session MFA

Some Teleport nodes require an MFA tap for *every session*. `tsh proxy ssh` —
the transport behind the shared connection — cannot perform that ceremony, so
those nodes fail with `too many authentication failures` over the normal path.

Right-click such a host and choose **Open with MFA (tsh ssh)**. The session is
dialled with `tsh ssh` directly and the prompt appears in the terminal:

```
MFA is required to access node "mfa-node"
Available MFA methods [WEBAUTHN, BROWSER]. Continuing with WEBAUTHN.
Using platform authenticator, follow the OS prompt
```

ServerLife also recognises that failure signature on its own and offers the MFA
transport in the failed pane, rather than a retry that would fail identically.

**The file browser still works.** `tsh ssh` has no SFTP subsystem flag, but it
can run a command — so ServerLife execs the remote `sftp-server` over a tsh
session and speaks SFTP down that. One MFA approval opens the channel; browsing,
uploads and downloads then run on it with no further prompts.

Because each channel costs an approval, they are never opened at the same time:
the terminal prompts first, and the file list waits behind a **Load files
(approve MFA)** button. Two OS prompts at once would simply cancel each other.

**Hosts remember.** The first time a node turns out to need MFA — whether you
chose it or the shared path failed — it is marked, and future connections go
straight to `tsh`. Marked hosts show an `mfa` badge; right-click → *Forget that
this needs MFA* clears it.

**Run a command… and multi-exec answer it too.** Neither has a terminal of its
own for the prompt to appear on by default, so a per-session MFA node used to
just hang or fail outright. Both now show the prompt right where the command
is — a line beside the output, or beside that host's row in a run across
many — answered without losing the rest of the run.

If a ceremony is cancelled or times out, the pane offers the alternatives
rather than leaving a dead terminal: retry, a security key, an **OTP code**
(typed in the terminal, needing no OS prompt at all), the browser, or a copy of
the exact `tsh` command to run elsewhere. Terminals, port
forwards (`-L`/`-R`/`-D`) and multi-exec all work too.

Pick the method in Settings — **Touch ID** is the default. It matters: tsh's
`auto` mode can choose a path that fails in a spawned process, and the failed
attempt consumes the challenge so the fallback fails as well:

```
MFA authentication with WEBAUTHN failed, check logs for details
Attempting MFA authentication with BROWSER
ERROR: failed to verify WebAuthn response: ".../webauthnsessiondata/login" is not found
```

Naming the method up front avoids that.

## Keys and known hosts

**SSH keys** sits under *Local* in the host list, beside the local shell and the
network tools, since "which key am I actually offering, and does the agent have
it?" is a question asked while a host is refusing you. `⌘⇧K` opens the same view.

Every keypair in `~/.ssh` with its fingerprint, type and size, whether it is
passphrase-protected, where it lives, when it changed, which `ssh_config` hosts
name it with `IdentityFile`, and a warning on any private key whose permissions
sshd will silently ignore.

- **What the agent holds, including identities that are not files here** —
  keys from the login keychain, a hardware token, another agent, or a Teleport
  certificate. These are listed separately and named by cluster and user rather
  than by their raw `teleport:proxy:cluster:user` comment; `tsh` loads each one
  twice (the certificate and the key it signs), so entries sharing a
  fingerprint are shown as one identity.
- **Run `ssh-add`** for the default identities, from the footer — and per key,
  with the passphrase asked for up front, since `ssh-add` cannot prompt usefully
  from a GUI app. Offered even when the agent is not answering, because
  `ssh-add` reports the real reason better than a guess does. Where there is no
  OpenSSH client at all, that is said plainly instead of failing obscurely.
- **Generate** an Ed25519, ECDSA or RSA key.
- **Install a public key** on any connected server — the `ssh-copy-id` step,
  done over the connection that is already open, so it needs no extra
  authentication.
- **Forget a host key** (host right-click) to clear
  `REMOTE HOST IDENTIFICATION HAS CHANGED` after a rebuild. A connection that
  fails this way offers the same fix right in the failed pane — **Forget old
  host key…** — rather than a raw ssh error and a menu item to go find.

## Teleport

- **Several profiles logged in at once.** Each is listed with its cluster,
  username, expiry and node count. Switch the active profile, or log in to a new
  cluster, from the Teleport tab. The login dialog takes a proxy, optional user,
  **auth connector**, cluster, TTL and MFA mode, and previews the exact `tsh`
  command before running it. Connections always carry an explicit
  `--proxy`/`--cluster`, so which profile is "active" never changes where a
  session goes.
- **Leaf clusters.** A root that trusts other clusters gets a leaf badge on its
  heading, carrying the number behind it, and clicking it switches — the root
  and every leaf in one list, each with its labels, since a leaf is usually
  remembered by `env=prod` or a region rather than by name. Past ten leaves the
  menu becomes a searchable dialog that matches names *and* labels. When the
  profile is already pointed at a leaf the badge says **leaf** instead of a
  count, because the name in the heading is then the leaf's and nothing else on
  screen would tell you which of the two you are looking at. Switching runs
  `tsh login <cluster>` against that profile.
  **Sessions on a leaf node always use `tsh ssh`**, never the multiplexed
  OpenSSH transport: the certificate is issued by the root and the node wants
  the leaf's role mapping, so the session pane says the transport was forced
  rather than letting the connection fail.
- **Access requests.** List them with their state, see details, create new ones,
  **assume** approved roles, and drop them when done. Assumed requests are
  marked on the profile.
  - **Browse what you can request** — *New request → Browse…* lists everything
    `tsh request search` reports for the cluster (servers, applications,
    databases, Kubernetes clusters, desktops…) by name and label, filterable as
    you type. This is deliberately a different set from the sidebar: a request
    is for a resource you **cannot** see yet, so `tsh ls` may show 3 nodes where
    13 are requestable.
  - **Kubernetes namespaces and pods**, not just whole clusters — pick
    *Kubernetes namespaces/pods* as the kind, then which cluster to search
    inside, namespaces or pods, and (for pods) a namespace or *every
    namespace*. This needs a Teleport role that grants
    `allow.request.kubernetes_resources` pointed at a role with real access
    (`search_as_roles`) — the same shape every other resource request here
    already needs, just scoped tighter than a whole cluster.
  - **Two shortcuts straight to it**, since picking the cluster by hand here
    is one more step than it needs to be when you are already looking at
    (or already pointed at) the cluster in question:
    - A kube cluster that is still only **requestable** — right-click it
      (sidebar, or the Hosts pane) for *Request a namespace or pod…*,
      beside the existing *Request access to it…* for the whole cluster.
      Useful for exactly the case where the whole cluster is more than you
      need — a cluster's `prod-eks`, say, when one namespace in it is the
      actual ask.
    - A cluster you already have open — its browser toolbar has its own
      **Request namespace/pod access…** button, next to *My access*. Both
      land in the same namespace/pod picker, already scoped to that
      cluster, instead of the generic Browse… picker's own cluster
      dropdown.
  - **Names, not UUIDs.** Requests show `node/monitoring-01` instead of
    `node/d68f45ed-cbe5-433b-9eab-f8400966da4f`, resolved through
    `tsh request search`; the raw id stays in the tooltip.
  - **Requestable roles** come from `tsh request search --roles` as a checklist.
  - **Timing.** Say when access takes effect (defaults to now), when the
    request expires unreviewed, how long access lasts once approved, and when
    the elevated certificate ends — `--assume-start-time`, `--request-ttl`,
    `--max-duration` and `--session-ttl`. **Suggested reviewers** optional.
  - **The exact `tsh` command** is shown back, folded away, with a Copy button
    that works without expanding it.
  - **Save and raise again.** Keep a set of resources, roles and reason under a
    name against its cluster, then load it back from *Saved…*. *Save as
    reusable…* does the same from an existing request — pending, approved or
    expired — so the access you had to ask for once is one click away next time.
- **Tags.** Every label on a node — static ones and dynamic command labels
  alike — is read from `tsh ls --format=json` and shown in the sidebar. **Show
  tags** puts them under each host as `key = value` chips; with it off, the row
  summarises the most telling one (`dev +9`) without squeezing the host's name,
  which keeps its width and lets the badge truncate instead.
  Hover a host for the full set, or
  right-click → *Tags…* for a list including Teleport's internal labels.
  Clicking a chip filters by that tag; clicking it again removes it.
- **Search by tag.** The host filter reads labels, not just text:

  | Query | Matches |
  |---|---|
  | `env=prod` | label `env` is exactly `prod` |
  | `env:pro` | label `env` contains `pro` |
  | `env=prod,staging` | either value |
  | `env=prod*` | glob |
  | `env:` | has an `env` label at all |
  | `tag:gpu` | any label key or value contains `gpu` |
  | `cluster=corp` | a non-label field: name, host, cluster, addr, proxy, type, tunnel |
  | `-env=dev` | exclude |
  | `name~^web-\d+$` | a regular expression against a field or a label |
  | `a and b`, `a or b`, `not a` | spelled out, with brackets to group |

  See [Boolean rules](#boolean-rules) for the longer version — the same
  syntax a folder's rule is written in.

  Terms combine with AND, quotes hold values containing spaces together, and a
  key written without its prefix still finds it — `location=east` matches
  `aws/location`. **Tags…** browses every label in the inventory grouped by key,
  with a count per value, and the box autocompletes pairs it has seen.
- **Session recordings** — *Teleport → Recorded Sessions…* (`⌘⇧Y`), or
  right-click a host → *Recorded sessions for this host…* to land pre-filtered
  — a logged-in Kubernetes cluster's own right-click menu has the same thing,
  *Recorded sessions for this cluster…*, beside *Active sessions on this
  cluster…*. Each row shows node, user, login, duration and time. **Play** replays it in a
  tab via `tsh play`; **Web UI** opens it in Teleport.
  - **Interactive sessions only, by default.** A cluster's recording list is
    mostly `exec` records — every scripted command, every health check — and
    none of them have anything to replay. They are filtered out, the count of
    what was hidden is shown, and one checkbox brings them back.
  - **Range**, beside the cluster picker — a day by default, up to 180
    (Teleport's own practical maximum), the same choices Search transcripts
    already offered — or type an exact day into **From**/**To** directly,
    which the dropdown just fills in rather than being a separate thing.
    Without this there was no way to see anything older than a day at all;
    `tsh recordings ls` silently defaults to that when given no range,
    which is what this list used to do too.
  - **A cluster whose session has lapsed** is still offered in the Cluster
    picker, marked *(expired)*, rather than disappearing from the list the
    moment it is not — picking it offers **Login** instead of a recordings
    list, the same thing an expired profile already offers everywhere else
    in the app.
  - **Not just SSH.** `tsh play` replays Kubernetes, application and database
    sessions too — a row shows a small `kube`/`app`/`db` tag beside its name
    when it isn't an SSH one. App and database sessions carry their own
    event shape rather than SSH's (no hostname, no explicit interactive
    flag), so they are named from whichever field they do carry and shown by
    default rather than assumed non-interactive and hidden. A real
    interactive Kubernetes session's exact event shape could not be
    captured to confirm this against — none existed on the cluster this was
    built against, and generating one needs a genuine interactive terminal.
  - **Paste a session id** into the filter and it is recognised as one even when
    that session is outside the range loaded, offering to play it, open it in
    the web UI, or flag it. A recording you were sent in a ticket needs no date
    arithmetic first.
  - **Flags and notes.** The **☆** on any row keeps that session, with a note
    saying what happened there and why you might want it again. *Flagged only*
    lists what you kept — including sessions the cluster has since aged out of
    the range on screen, since a flagged session is one you decided mattered.
- **Search what was typed.** The *Search transcripts* tab fetches the text of
  every recorded session in a time range and looks for a word or regular
  expression, showing matching lines with context and a jump to play or open
  each session. Optionally it downloads every transcript it scans into a folder.
  Non-interactive exec sessions have no transcript and are skipped by default;
  progress is reported and the run can be stopped. Teleport lists recordings by
  **date**, and rejects ranges beyond roughly half a year, so 180 days is the
  maximum offered.
- **Connection history.** A local log of every session this app opened,
  successes and failures, including plain SSH hosts that Teleport's audit log
  never sees.
- **Server profile.** Right-click a host → *Server profile* for distribution,
  kernel, architecture, CPU, memory, disk, virtualisation, init system and
  package manager — one round trip over the existing connection.

### Access requests, where you will see them

A request is something you are waiting on, and waiting is the wrong shape for a
button you have to remember to press. The list is re-read every ninety seconds
(paused while the window is hidden) and what it finds goes where it will be
noticed:

- **A badge on the Teleport tab** with the count — amber while a reviewer still
  has it, green once there is an approval ready to assume.
- **A `n req` tag on each cluster's heading** in the host list, clickable
  straight into that cluster's list.
- **Right-click a cluster heading** for *Access requests — 1 waiting, 4
  approved…*, or right-click the sidebar's tab strip for every cluster at once,
  plus *New request…*.

Only what you could act on is counted: pending review, or approved and still
usable. An approval that expired unused is history rather than something to do.

### Monitoring what you could ask for

The other direction. A request tells you about access you have asked for;
this tells you whether the thing you **expect to be able to ask for** is still
on offer. `tsh request search` is not a stable list: a node is rebuilt under a
new id, a role changes and a whole kind stops being offered, a resource is
retired and simply stops appearing. None of that announces itself, so you find
out at the moment you needed the access — which is the worst moment, because
the request you were about to raise is the thing that has gone.

Open it from **Teleport → Monitor Requestable Resources…**, the *Monitor
requestable…* button under the Teleport tab, or **right-click a cluster
heading** in the host list, which goes straight to that cluster's resources.
Pick what matters from the same picker an access request uses, and a small
pane floats above the app — drag it by its head, and it stays where you put
it:

- **Every five minutes** (1, 5, 15, 30 or hourly, at the foot of the pane) the
  search runs again. Each resource reads **✓ requestable — confirmed 2m ago**,
  or **⊘ not requestable — missing 14m, last confirmed 3h ago**.
- **What was saved is what is shown.** The name, the node id, the cluster and
  the labels are written down while the resource is there, and drawn from that
  record once it is not — `env=prod`, `role=database` and the name it went by
  are all anyone has to go on afterwards, and a row reading
  `/cluster/node/ea9f6ccd-…` is a row nobody can act on.
- **A resource is only ever called missing off a successful search.** A lapsed
  certificate, a proxy that will not answer, a role that cannot search that
  kind — each produces an empty list that means nothing, and the pane says
  *could not search…* instead of condemning everything on it.
- **An unreachable cluster says so, per row.** Those resources read
  **? not checked — cluster unreachable, last confirmed 4h ago** in amber,
  and the head counts them alongside the missing. Which cluster last answered
  and which last failed is kept in your settings, so logging out on Friday and
  opening the app on Monday shows *not checked* rather than a tidy row of
  green ticks confirmed three days ago. The same applies when the app simply
  has not run a check in a while.
- Monitoring **carries on with the pane closed** — that is the point of it —
  and the cluster heading's menu carries the count, so *2 of 7 missing* is
  visible without opening anything. Closing the pane stops nothing; the **×**
  on a row is what stops watching that one.
- **The pane never opens itself.** Not even if you left it open when you last
  quit: a floating window appearing over the app at launch is an
  interruption, and this one has nothing urgent to say most mornings.
  *Settings → Open the requestable-resource monitor when the app starts*
  turns that on if you would rather have it up.

### Teleport homes

*Settings → Teleport homes → Add a directory…* opens a small dialog: type the
directory or press *Browse…*. The path may use an **environment variable** —
`$TELEPORT_HOME`, `${WORK}/.tsh` — read each time the app starts and when
Settings are saved, and the dialog says where it points now and how many
profiles are there; one naming a variable ServerLife can't see is skipped
until it can. The same dialog takes **variables for that home** — `NAME=value`
lines such as `TELEPORT_TOOLS_VERSION=18.11.10` — set for every tsh command run
with it, over the ones for every cluster and under a cluster's own. Each home's
row has a *vars* button to change either.

### Which tsh

*Settings → Teleport homes → Locate tsh / ssh…* sets **Path to tsh** — another
version's build, say — and it applies on *Save*, with no restart; *Browse…* opens a
`tsh.app` as the folder it is, since a signed tsh has to be run from
`tsh.app/Contents/MacOS/tsh` (copied out of the bundle, macOS stops it on
launch). `TSH_PATH` does the same when it is set at launch.

A tsh picked either way **runs as itself**: Teleport's client-tools managed
updates would otherwise hand every command to the version they installed for
the cluster, so a build of another version named `tsh` reported, and behaved
as, 18.11.7.
That holds in terminal tabs too — logins, recordings, Phase build consoles.
A tsh the app finds for itself keeps the managed updates.

**At launch, ServerLife says when either is in force** — *Using a custom tsh
(Settings): … — v18.11.9*, and the Teleport homes being read — and, when the
picked tsh will not run at all, says that instead of leaving the list empty.

**Environment for tsh.** Variables to run tsh with — *Environment for tsh* in
*Locate tsh / ssh…* for every cluster, and *tsh environment for this
cluster…* on a cluster heading's menu for one, on top. One `NAME=value` per
line, as Teleport's docs write them (a pasted `export NAME=value` reads the
same). They reach every tsh the app runs for that cluster — background reads,
sessions, beams, Phase builds, logins — on *Save*, and a heading with its own
shows an **env** tag. The case they are for is the client tools version:
`TELEPORT_TOOLS_VERSION=18.11.9` for one cluster has tsh fetch and run that
version for it alone. Each box shows that line to copy, with *Insert*;
change the number to the version wanted. A tools version set this way is
the one used, even for a tsh picked in *Path to tsh*. *Also in local shell
tabs* sets the every-cluster ones there as well.

### What tsh says

*Status (tsh status)…* on a cluster's heading — and the **Status** button on its
profile row — shows the app's own view of that profile (cluster, proxy, user,
roles, logins, expiry, tsh home) above the **printed** `tsh status` output,
which is what people compare against a terminal and paste into tickets, and
the cluster's own version, read from the same unauthenticated `/webapi/ping`
*Cluster info…* already uses.

`tsh status` leads with whichever profile is *active* and lists the others after
it, so when the cluster you asked about is not the one at the top, the dialog
says so rather than leaving you to notice.

**Refresh**, beside Status on a cluster's profile row, re-reads just that
cluster — its nodes, leaves and beams — without waiting on, or triggering, a
refresh of everything else.

### An expired cluster that will not go away

A profile lives in the tsh home as a `<proxy>.yaml`, and that file is what
`tsh status` reads — so a cluster whose certificate expired stays listed,
with empty roles and *[EXPIRED]* against it, until the file goes. For a lab
that was torn down or a demo cluster that no longer resolves, that is
forever.

An expired group now carries **Remove** beside *tsh login* and *Copy login
cmd*. It names every file it is about to delete — the profile, any key
material left behind, and the `current-profile` marker if it pointed there —
and deletes them on confirmation. Not `tsh logout`: that is right for a live
cluster and can sit waiting on a proxy that is no longer answering, which is
precisely the case this exists for. Nothing on the cluster is touched, and
logging in again recreates the profile.

**What an expired group still lists** is a setting: *Settings → When a cluster
logs out or expires, show*. **Only watched hosts** (the default) draws just the
machines you marked to be told about. **The last known hosts, for a while**
also draws everything else the last successful read had, dimmed, for the
number of hours set beside it; **always** keeps them until the cluster is read
again. They come from memory, so a restart starts with only the watched ones.

### Logging in again

A Teleport profile only exists while its certificate does. *Save cluster* keeps
the details that survive a logout — proxy, user, connector, tsh home, TTL — so
logging back in is a click rather than a remembered hostname. Saved clusters
are listed under the live ones in the Teleport tab.

**The proxy address is the host and port, and nothing else.** The address
anyone has to hand is the one in their browser's bar, so it arrives as
`https://example.teleport.sh/web` — and `tsh login --proxy=https://…` fails,
or logs in and stores a profile under a name nothing else in the app matches.
The scheme and anything after the host are dropped as soon as the field loses
focus, where you can see it happen; the port is part of the host and stays.
Every command built from a cluster applies the same rule, so one saved before
this gets it too.

**Save** and **Login** are separate buttons in the cluster dialog, because
editing a kept cluster — correcting a proxy address, switching the connector,
pinning a tsh home — is not the same act as logging in, and before that the
only way to keep a change was to run a login you may not have wanted to run
right then.

**A login that names a user opens a terminal.** `tsh login --user=…` is heading
for a password, an OTP or a hardware key, and a prompt in a spawned process with
nowhere to draw is a login that hangs and then fails — so it runs in a local
shell tab where you can answer it, and the inventory is re-read when the command
exits. That applies wherever a login starts: the dialog, the **tsh login**
button on an expired cluster, and automatic login. **Passwordless** (Touch ID or
a security key) is treated the same way: the challenge needs a real foreground
process to answer it, which a background one is not.

**Opening a host on an expired or logged-out cluster logs in first.** Double-
click a node, pick *Reconnect*, or open a tmux session on a cluster whose
certificate has gone, and ServerLife asks — *Log in to prod?* — then runs the
login the cluster is saved to use, and **carries on connecting to the host the
moment it finishes**, terminal login included; there is no second double-click.
*Settings → Ask before logging back in to connect* (or *Do not ask again* on the
prompt) skips the question. A cluster logged out of on purpose is logged back
into this way too, since asking to connect is itself the deliberate act; only
a tmux pane quietly healing itself in the background leaves it alone.

**Pin a cluster to the Hosts tab** to keep it listed when `tsh status` no
longer is. A logout deletes the profile, and the cluster's heading went with it
— its watched hosts dropped into the catch-all *Watched* group as though the
cluster had been removed. A pinned cluster keeps its group, marked **logged
out**, with its watched hosts in it, *tsh login* and *Copy login cmd* using the
saved details, and *Unpin* in place of *Remove*. Pin from the **Pin** button on
a cluster in the Teleport tab (a cluster that was never saved is saved with
it), from a saved cluster's own **Pin**, or with *Pin to the Hosts tab* when
registering one. **Unpin** keeps the saved login. While `tsh status` lists the
cluster, expired or not, its own group is drawn instead.

**Log in automatically when the app starts** is per cluster and off unless
asked for. Ticked, that cluster is logged in at launch if its certificate has
gone. One at a time, because an SSO login opens a browser and four browser tabs
fighting over the foreground is worse than clicking one button; a cluster whose
connector needs a terminal is exactly the case this cannot serve, and it says
so rather than taking the others down with it.

### Leaf clusters

A root cluster that trusts others gets a leaf badge on its heading, carrying
the number behind it. Clicking it switches: the root and every leaf in one
list, each with its labels, since a leaf is usually remembered by `env=prod` or
a region rather than by name. Past ten leaves the menu becomes a searchable
dialog that matches names *and* labels.

When the profile is already pointed at a leaf the badge says **leaf** instead of
a count, because the name in the heading is then the leaf's and nothing else on
screen would tell you which of the two you are looking at. Switching runs `tsh
login <cluster>` against that profile.

**A session on a leaf node always uses `tsh ssh`**, whatever transport was
asked for. The ssh_config route would connect — the leaf trusts the root's user
CA — but it would do so holding the root's certificate, which is the only one
`tsh config` names; going through tsh gets a certificate issued *for the leaf*,
so the leaf's role mapping and principals decide what the session can do. The
session pane says the transport was forced rather than letting it fail.

### Putting a cluster in ~/.ssh/config

*Add to ssh config…* — on a profile row in the Teleport tab, and on the
cluster's heading menu in the host list — writes that cluster's `tsh config`
block into `~/.ssh/config`. The app itself does not need it: it generates its
own config per connection. This is for everything else that speaks ssh and
nothing else — `ssh node.cluster`, scp, rsync, Ansible, git, VS Code Remote.

What it would write is shown first, and then:

- It goes in **between markers naming the cluster**, so writing it again
  replaces it in place. A literal `tsh config >> ~/.ssh/config` run twice
  leaves two blocks with the same `Host` patterns, where the first quietly wins
  and the second is dead text that reads as live.
- It goes at the **top** of the file when it is new, because ssh takes the
  first value it sees for an option and a block after a catch-all `Host *`
  can be silently overridden.
- Everything outside the markers is left alone, and the file is backed up
  first.
- **If the cluster is already in there** — a `tsh config` someone ran by hand —
  it says so, names the patterns it found, and asks again before adding a
  second block, because that duplicate is the user's own text and the app
  cannot clean it up for them.

### Nodes that have gone quiet

A node is in the cluster's inventory because its agent keeps announcing it. If
that stops — the agent crashed, the machine is wedged, the network went — the
node does not disappear straight away. It sits in the list looking exactly like
a healthy one, still offering to connect, for the ten or fifteen minutes the
cluster waits before dropping it. A session opened in that window does not fail
quickly: it hangs waiting for a tunnel with nobody on the far end.

So a node that has not been heard from for a couple of minutes gets an amber
**⚠ 6m** on its row, counting the silence, and its tooltip says how long it has
left before the cluster forgets it entirely.

The cluster does not publish a "last seen" time; what it publishes is when it
will give up on the node, and every heartbeat pushes that a full announce
interval into the future. The age is the difference between the two. The
interval itself is not in the output either, so it is read off the cluster's
own healthy nodes — the freshest of them has just heartbeated, and that is the
full interval. A cluster with a single node in it cannot be measured that way
and will warn late or not at all, which is the harmless direction to be wrong
in. Hosts with no heartbeat to be late — agentless OpenSSH nodes, anything
registered without an expiry — are never marked.

**Heartbeats**, beside *Show tags*, puts the same figure on every Teleport row
— `♥ <1m` on a node that is answering — for when you are watching something
come back, or want to know whether the list is telling you the truth. It is in
minutes because changing the text rebuilds the list; the exact seconds are in
each row's tooltip.

**Kubernetes clusters get heartbeats too**, with *Heartbeats* on. Teleport
publishes none for a Kubernetes cluster (`tsh kube ls` carries no expiry), so
each cluster is asked — `GET /readyz`, which any signed-in user may read —
once a minute for one you are logged in to, every five minutes for one you
can use but have not logged in to (through a kubeconfig of the app's own,
never `~/.kube/config`). The row shows `♥ 0.5s` while it answers, an amber
`⚠ 3m` counting from when it stopped, `⚠ log in` when its credentials were
refused or a sign-in plugin is missing, and `· no access` when Teleport
answered that your role gives no Kubernetes access to it. A cluster you can
only request cannot be asked, but Teleport lists it only while its agent
heartbeats, so it says `♥ listed`.

A check never makes tsh log in again or ask for MFA: a cluster reached
through Teleport is asked only while its cached certificate, or for one not
logged in to its Teleport login, is good — read from the tsh home the
cluster actually uses, so with several homes a good login in one never
vouches for an expired one in another — and is `· not checked` otherwise,
until you open it. One that asks for MFA is not asked again that run.
Heartbeats for the same cluster name in two Teleport clusters or two tsh
homes are kept apart, and each has a kubeconfig of its own. Nothing is asked
with *No background commands on servers* on.

**The quiet button** appears next to it as soon as something has gone quiet,
carrying the count, and cycles through three states:

| It says | The list holds |
|---|---|
| `Quiet: 2` | everything, the quiet ones marked where they stand |
| `Quiet hidden (2)` | only the nodes that are answering |
| `Only quiet (2)` | only the ones that have stopped — what you want when something has taken a rack or a subnet with it |

The count stays on the button in all three, because a cluster that is quietly
two nodes short is the thing worth knowing. Right-click any Teleport host for
the same three as named items.

*Settings → Warn about nodes that have gone quiet* moves the threshold, or
turns the warning off.

### Hosts that disappear entirely

A quiet node is still in the inventory. The other failure is the one the
list cannot show you at all: a node that is decommissioned, rebuilt under a
new id, or dropped by an autoscaler stops being drawn, and nothing says so.
The row is gone, so there is no row left to carry the news — you find out by
going to look for the machine.

Right-click a host → **Tell me if this host disappears**. From then on its
**node id and everything last known about it** — name, address, labels,
cluster, and when it was last seen — are kept, because once it has gone the
cluster cannot be asked any of that, and "something has vanished" is not
enough to act on.

A watched host carries a small **🔔** beside its star, so you can see at a
glance which machines you are being told about. *Settings → Bell on hosts
watched for disappearance* turns that mark off — thirty marked machines is
thirty bells, which is where a mark stops meaning anything — and the same
place says how many are being watched and will stop watching all of them.
The watch itself is unaffected: the message when something goes, and the row
that stays behind, are the part that matters.

When it stops being listed you get a message, and the host **stays in the
list**, struck through and dimmed, with **⊘ gone 2h** and a tooltip holding
the record. It cannot be opened or ticked for multi-exec — there is nothing
there — and its menu offers the node id and *Stop watching and forget it*.
If it comes back, the mark clears itself and says so.

A host is only ever declared gone off the back of a **successful read** of
its cluster. An expired certificate, a proxy that will not answer, a `tsh
ls` that failed — each produces a list with the host missing from it, and
none of them means the machine is gone.

Gone hosts are counted by the **quiet button** and listed by *Only quiet*, so
that mode is everything that has stopped answering, whether it went silent or
went away. But *Hide quiet* does not hide them, and neither does the
twenty-per-group cap: a node that stopped checking in is noise you may
reasonably want out of the way, while a host you marked in advance and that
has since left the inventory is the answer to a question you asked.

**A watch ends when you end it.** Not when its cluster expires, is logged out
of, or is removed: the record lives in your settings, not in the cluster, so
a gone host keeps its row through all of that. An expired cluster still draws
its ghosts above the login prompt, and any whose cluster is no longer listed
at all are gathered into a **Watched** group at the foot of the host list.
They leave when you choose *Stop watching and forget it*, and not before.

**Out of reach is not gone.** A cluster describes itself with two lists that
do not overlap: `tsh ls` is what you can reach, and `tsh request search` is
what you could ask to reach. A node moves between them without changing in
any way — an approved request expires, a role is edited — and to anything
watching only the first list that move looks exactly like the machine being
decommissioned. So a watched host missing from the inventory is now looked
for in the other list before anything is concluded. If it is there the row
says **req**, in blue rather than red: the machine is fine, the access is
what went. **Double-click it to start a request** with that node already
chosen, or use *Request access to it…* from its menu. If it comes back to
standing access the mark clears itself and says so.

**The hosts pane has a `Requestable` toggle**, off by default, which adds
everything that cluster would let you ask for — tagged **req**, double-click
to ask. They are host-shaped like everything else in that list, so the
filter matches them, a folder rule claims them, and they can be dragged into
a folder by hand: one arrangement of a cluster, whether or not you hold the
access today.

**Kubernetes clusters show up in this same list**, for a root Teleport
cluster (not a leaf, and not the Saved group) — logged-in, offered but
not yet logged in, and (with the toggle above) requestable, all
host-shaped the same way a saved profile is above: filtered, foldered
and dragged exactly like an SSH host, with its own ☸ mark and the same
**req**/**available** tags standing in for the heartbeat and `gone`
marks that mean nothing for a cluster. Double-click opens it, logs into
it, or starts a request, whichever it currently is; the bulk "Request
access to N selected nodes…" action only ever counts the SSH ones in a
mixed selection — a kube cluster's own request goes through its
single-row menu instead. Kubernetes rows count towards *Hosts listed per
group in the sidebar* like SSH hosts, logged in or not, and so do the Local
kubeconfigs (with *show all* for the rest). SSH and Teleport hosts carry a small **server
icon** in the same place, so the two kinds read apart at a glance — *Settings →
Server icon on SSH hosts* turns it off. A watched cluster that has gone keeps its
☸ on its gone row.

**And a Refresh button**, beside the cluster picker, re-reads just what that
pane is showing — a leaf cluster's nodes, or the same re-read the sidebar's
own ⟳ makes for a root cluster or an ssh config file — instead of refreshing
everything.

**And a Saved toggle**, off by default, lists every saved profile — SFTP,
VNC, RDP, serial, telnet and SSH — as its own group alongside whatever
cluster or ssh_config group is already showing. They are host-shaped there
too: picked, split beside or below the current pane, filtered and dragged
into a folder the same as anything else in the list.

**And a third answer: `? unchecked 4h`.** *Gone* is a verdict, and it is only
ever reached through a successful read of a list that had other machines in
it. When the cluster cannot be read at all — logged out, certificate lapsed,
proxy down, the laptop shut all weekend — a watched host is neither confirmed
nor known to have left, and the app used to say nothing at all. Saying
nothing is the one wrong answer: a list of watched hosts with no marks on it
reads as *all present* when what it means is *nobody has looked since
Friday*. Those hosts carry an amber **? unchecked** with how long it has been
since anything confirmed them, and the group heading counts them. A host
known to be **requestable** ages the same way: it keeps its **req** tag, since
that is the last thing known, and gains **? unchecked** with how long ago a
check last found it requestable.

**A verdict lasts only as long as it can be re-tested.** A host marked gone
whose cluster you then log out of stops being reported as gone: nothing can
check it any more, so *gone* is a claim with nothing behind it, and a row
asserting a machine has been decommissioned when the honest answer is "we
have not been able to look since you logged out" is worse than saying
nothing. It shows as **? unchecked** instead, and the tooltip keeps the
finding as a note — *it was absent from the last list that could be read, at
12:05* — so nothing is lost. Log back in and the next successful read
restates it, or clears it. The requestable-resource monitor follows the same
rule.

**Profile…** on the menu of a watched, unchecked, missing or requestable host
shows everything known about it — the cluster and proxy it came from, its node
uuid, hostname, address, labels, when it was last seen — each with a copy
button, and **Copy the login command** for its cluster. A requestable host can
be watched too (*Tell me if this host disappears*), and carries the same bell.

### Latency to a node

*Latency to this node…* on a Teleport host runs `tsh latency ssh`, which
measures both halves of the path: you to the proxy, and the proxy to the node.
That is the question when a session feels slow but a ping to the proxy looks
fine.

It is a live view that draws its own screen and insists on a real terminal, so
it opens in a tab of its own rather than being captured into a dialog — the
same treatment session replay gets. The tab opens without the file browser,
since there are no files to look at; `⌘E` shows it. Close the tab to stop it.

---

## Beams

A **beam** is an ephemeral sandbox VM: `tsh beams` creates one on demand, it
expires on its own, and it never appears in the cluster's node inventory.
ServerLife lists them **inside their cluster's group** under a `beams` heading —
with the cluster, because that is where they run; marked off, because a beam is
not a server. Each row carries its region, a live countdown to its expiry and a
**beam** badge, and the last row is always *+ Start a beam…*.

- **Support is discovered, not configured.** `tsh beams ls` answering at all is
  the test; a cluster without the service replies *unknown service
  teleport.beams.v1.BeamService*, and the answer is remembered per proxy. A
  cluster under **beams.sh** or **beams.run** is a beams cluster from the start,
  without waiting on that test. Any other cluster that cannot be asked right now
  — an expired certificate, a slow proxy — can be marked as a beams cluster by
  hand from its heading menu; *Stop marking this as a beams cluster* turns the
  default off for a beams.sh one, and any cluster's beams can be hidden.
- **Everything the app does to a server, it does to a beam.** Double-click one
  and you get an ordinary session: a terminal, the file browser beside it, the
  transfer queue, compare, synchronize, keep-a-folder-up-to-date, *Edit in my
  editor*, and drag-and-drop between panes. None of it is beams-specific code —
  `tsh beams ssh` is the terminal, and `tsh beams exec` runs the beam's own
  `sftp-server` to carry SFTP, so a beam is just another connection to
  everything above.
- **The whole `tsh beams` command set** is on the row's menu:

  | | |
  |---|---|
  | *Open a session* / *Open the file browser* | a terminal, or files with no terminal |
  | *Run a command…* | one command answered in a dialog, no session needed |
  | *Publish a service…* | expose an HTTP or TCP service running inside the beam; the address is captured and copied, and unpublishing is the same dialog |
  | *Copy files (scp)…* | `tsh beams scp`, in either direction, for a whole directory in one call |
  | *Delete this beam…* | asked first, because nothing on it comes back |

- **A beam takes no port forwards.** Publishing a service is the beams-shaped
  answer to the same question, and the refusal says so rather than failing
  obscurely.
- **The list re-reads itself every minute** (and pauses while the window is
  hidden), because beams expire on their own and anyone with access to the
  cluster can start or delete one. Deleting retries the concurrency error the
  service returns for a beam created moments earlier, then confirms the beam has
  actually gone before saying it did.
- **Beam macros** — twenty-four, in the ▶ menu of a beam's session only:
  `beamctl` services and their logs, starting, freezing and waiting on one,
  publishing and unpublishing, identity, what the beam can reach, its AI
  gateway, and saving a Phase build. See [Macros](#macros).
- **A beam's menu says what it was started from**: *From Phase sage-garden…*
  with the Phase's history, or *Standard image* — and each beam row carries a
  tag naming its Phase. See [Phases](#phases).
- A beam also registers as a node called `beam-<uuid>`; those are filtered out
  of the cluster's node list, so each beam appears exactly once — under its own
  name, where it can be managed.
- **An agent opens a beam by its name**, through the same MCP tools it uses for
  servers — see [MCP](MCP.md). The name has to match exactly: a beam's name is
  made up by the service and can sit beside a server with a similar one, and
  the two are reached differently, so a near miss is never guessed at.

### Phases

A **Phase** is a saved beam image: build it once with the tools a job needs,
and every beam started from it has them. ServerLife offers Phases only where
the tsh it runs has them — `tsh phase` and `tsh beams add --phase` — which is
asked of the binary itself; 18.11.9 has them, 18.11.7 has neither, and without
them the dialogs look exactly as they did. (To run another version for a
cluster, see [Which tsh](#which-tsh).)

- **Beams | Phases | failed**, as tabs in a beams cluster's group. *Phases* is
  `tsh phase ls`: each Phase with its state, what it was built from and when it
  was saved, a tooltip with its snapshot, region, owner and, for a failed one,
  the error and how to look inside it. *failed* is `tsh phase ls-failed`: the
  snapshots failed builds left behind. ⟳ reads either again.
- **Start a beam…** gains **Start from** — the standard image or any ready
  Phase, picked from your Phase folders (opened and closed as on the Phases
  tab) or found with the search box above them; the region follows the
  Phase's. New Phase's *Phase* and the setup builder's *Builds on* choose the
  same way — and **Delegate roles**, your roles
  on that cluster with a tick each; none ticked leaves `--roles` off. A beam
  started there **can't be saved as a Phase** — `tsh phase snapshot` saves only
  from a Phase's own build beam — so the dialog says so in a line, with a
  *start a Phase build instead* link that opens New Phase (on top of the Phase
  you picked, if any) — or a *build one from setups* link, which opens the
  builder on it. Use a Phase build whenever you plan to keep what you do.
- **+ New Phase…** offers *Build it from setups instead…* at the top, where tsh
  has `phase apply`, for anyone about to install tools by hand in a console. It
  builds one, from the default base image, **on top of a
  Phase** (`--from`, also any upstream image like `default:v1`, or an exact
  `name@sha256:…` snapshot) or **forked from one** (`--fork-from`). It is built
  **in an interactive build console** — a shell on a build beam, in a new tab;
  install what the image needs and run `tsh phase snapshot --final` — or **from
  a command file** (`--commands-file`), whose log streams in the tab. A command
  file lists commands as `command:` and `args:` (`shell:` is only for `tsh phase
  apply`). Roles and a region can be chosen, and the exact command is previewed.
  Where tsh has them, it can also be built by **copying files from this
  computer** (`--copy`, a local file or folder to an absolute path outside
  `/home`), and **started without opening its console** (`--no-console`) to
  come back to later.
- **+ From setups…** puts a Phase together from ready-made **setups**, as
  stages of a `phase.yaml` built with `tsh phase apply` (needs a tsh that has
  it). Each stage is its own Phase, built on the one before it: either it
  **installs and runs commands** (as root, run again whenever it refreshes —
  daily, and when the stage below changes) or it **copies files from this
  computer**, and either kind can start **services** in every beam made from
  it. The setups:
  - *Packages and languages* — Debian packages, compilers and build tools, Go,
    Rust, Java, uv, pnpm/Yarn/Bun.
  - *Cloud and infrastructure* — kubectl and Helm, Terraform, the AWS CLI, the
    Google Cloud CLI, the Azure CLI (from Microsoft's Debian 13 repository once
    there is one, bookworm's until then).
  - *Settings* — environment variables for login shells, and rebuilding an
    app's dependencies under `/home` (`npm ci` by default), which reserves that
    folder with `rebuild_home_paths`.
  - *Services* — clone a repository on first start (left alone once it is
    there), a PostgreSQL server (data in `/home/beams/.pgdata`, so a snapshot
    keeps your dev database; `psql` connects as `beams` with nothing to set
    up), a Redis server (in memory, empty in every beam), and *Run my app*.
  - *Files* — copy a file or folder in, and **My dotfiles and settings**:
    files from your home folder (`.gitconfig`, `.vimrc`, `~/.claude`…) put in
    the beam user's home on first start, without replacing ones already there
    unless you say so.
  - *Your own* — any command, or any service with its kind (`pre-start` or
    `background`) and when it runs (`user`, `runtime`, `snapshot`, `rebuild`,
    `build`, `all`).
    *Written in YAML* takes `commands:`, `services:`, `files:` and
    `rebuild_home_paths:` exactly as `phase.yaml` has them, for anything the
    others don't cover.

  The `phase.yaml` they make is shown beside them, colour-coded, and checked as it changes
  against the rules tsh applies — names, the order of stages, destinations
  outside `/home`, service names, the 32 KiB limit — so a mistake is named
  before anything runs. What is only not filled in yet — an empty stage, a
  required field left blank — waits until you build or save, rather than
  greeting a new stage with an error. *Build it* runs `tsh phase apply` in a tab, streaming
  each stage's log; *Build it, then work in it…* does the same and then opens
  New Phase on top of the last stage — an interactive build console with
  everything installed, which you save with `tsh phase snapshot`. *Save
  phase.yaml…* writes the file instead, and *Keep this setup* saves the
  stages to start from next time. Applying a name that is already a Phase
  replaces it, asked first.

  **Edit by hand**, above the `phase.yaml`, makes it an editor: anything `tsh
  phase apply` takes, checked as you type, and built and saved exactly as
  written, comments included. The stages on the left follow the text (dimmed
  while you type), and *Back to setups* carries it on as stages — what the
  setups do not cover arrives as *Written in YAML*. A copied file's `from:` must
  be a full path when written by hand: tsh reads a relative one against
  wherever the file is saved, and does not expand `~`. *Open a phase.yaml…*
  while editing by hand loads the file's own text, comments and all. Escape in
  the editor stays in the editor.

  **Open a phase.yaml…** carries on from one already written — saved, made by
  hand, or one a build left in `phase-setups/` (where the dialog opens): each
  document becomes a stage with its name, parent and kind, and what it holds
  comes in as *Written in YAML*, exactly as written, to change or to add other
  setups beside. Relative file paths are read from the file's own folder, as
  tsh would. A raw `--commands-file` opens as one stage.

  **Where these are kept**: each build's `phase.yaml` is written to
  `phase-setups/` in the app's data folder (on macOS `~/Library/Application
  Support/ServerLife/phase-setups/`), named after its first stage and the time;
  kept setups are saved with the app's settings. The cluster keeps the built
  images, each stage's parent, and its commands and services — but tsh doesn't
  give them back, so a stage can't be read back into the builder from the
  cluster. Keep the `phase.yaml` (or the setup) if you will want to change and
  reapply it; copied files exist only in the image once built.

- **My add-ins…** in the builder: setups of your own, one YAML file each, in
  the same list under their own group and checked the same way. An add-in
  gives a `label`, optionally a `group`, `help` and `fields` (a `key`, `label`,
  `default`, `required`, and a `kind` — `text`, `textarea`, `select` with
  `options`, `path` or `paths`), its `stage` (`commands`, `files`, or `any`
  for services only), and the `commands`, `services`, `files` and
  `rebuild_home_paths` it adds, written as in `phase.yaml`. `{{key}}` in any of
  those is what was typed in that field, and `{{key|sh}}` the same quoted as
  one shell word. The manager starts a new one from an example, checks it as
  you type — unknown keys, a `{{field}}` with no such field, the wrong stage —
  and shows the stage it would add. They live in `phase-addins/` in the app's
  data folder unless *Use another folder…* points elsewhere: a checked-out repo
  gives a team the same add-ins.
- **Right-click a Phase** for *History and beams…*, *Start a beam from it…*,
  *Fork into a new Phase…*, *Build a new Phase on top of it…*, *Edit in a build
  console…* (`tsh phase edit`), *Add setups on top of it…*, copying its name or
  exact snapshot, and *Delete Phase…* — asked first; beams already running from
  it keep running. A Phase built from commands offers *Replace its command
  file…* instead of a console, and one built from copied files *Copy its files
  again…* — either rebuilds it. While a Phase's build is running, the menu adds
  *Open its build Beam*, *Save a snapshot now* and *Save and finish the
  build…*; a snapshot refused for changes outside `/home` offers to save
  without them (`--force`).
- **Services…** on a beam's menu lists what beam-init is running in it — its
  Phase's services — with each one's state and log (`beamctl`).
- **History** shows the chain back to the base image — `default:v1 →
  sage-garden ⑂ my-fork`, ⑂ for a fork — what was built or forked from it, the
  beams running it, and the builds started from ServerLife with how each ended.
  Forks are known only from that last record: tsh lists a fork's *base image*
  as its parent, not the Phase it was forked from.
- **A build's result is read from the Phase**, not from tsh's exit code: a saved
  build ends its console with 255. A Phase saved since the build started is a
  success; a failed one brings its error, in a notice and in its details.

## KubeLife

**KubeLife** is ServerLife's Kubernetes module: contexts from the default
kubeconfig (and any you add) plus Teleport-registered clusters, listed right
in the **Resources** tab beside your SSH hosts — not a separate place to
look — exec sessions with the same file browser a server session gets, a full
cluster browser for every resource kind, Helm release management,
port-forwarding, a 3D cluster view, and Kubernetes clusters as a kind in
access requests. Reached
through either plain `kubectl` or Teleport's own kube proxy, by the same
means. It is being added in stages; this section grows as each one lands.

- **All / SSH / K8s**, above the Resources list, filters it to one kind or
  both — only shown while KubeLife is on, since "K8s" means nothing with it
  off. "All" is the default: a Kubernetes cluster is a thing you connect to
  exactly like a server, so it lives in the same list rather than a tab of
  its own. *K8s* still shows the **Local** group — a local shell, the AI
  assistants and the network tools are as useful beside a cluster as a
  server — leaving out only *SSH keys and certificates*.
- **Only what `tsh kube ls` offers is shown as connected.** A Teleport
  cluster's kube clusters are the ones its `tsh kube ls` lists for you; a
  context still in the kubeconfig for one that isn't (from an earlier login,
  or an access request that has ended) is never shown as something to open.
  If `tsh request search --kind=kube_cluster` finds that cluster it shows
  as requestable — *req* — with *Request access to it…* and *Request a
  namespace or pod…*; if it doesn't (the cluster is gone, or nothing grants
  it), it isn't shown at all.
- **Errors in plain words.** kubectl's own failures are put in a sentence:
  a cluster that isn't letting you in yet says so and offers *Request access
  to this cluster…* and *Request namespace/pod access…*; a refusal names what
  your role can't do ("can't list pods in kube-system"); stack traces and log
  lines never reach the screen. A list is always read and shown as it comes
  back: through Teleport, `kubectl auth can-i` answers "no" for lists that
  work (namespaces, or any kind across every namespace — Teleport filters the
  list to what your role covers instead of refusing it), so it is never used
  to stop one. Only when a list comes back empty is it asked, to tell *none
  your role can see* from *nothing there*: the Overview then shows — rather
  than 0, and an empty kind says so. A kind that is really off limits says
  what your role can't do, with *My access* and *Back to the overview* — a
  request button only beside those, and *Request access to this cluster…*
  only when the cluster won't let you in at all.
- **Kubernetes profiles**: *New profile → Kubernetes cluster (kubeconfig
  context)* saves a context with the namespace to start in and the view to
  open on — Overview, Pods, Deployments, Helm, 3D or Starred. Opening it goes
  through the same check a restored tab does: a context `tsh logout` removed
  is offered back with `tsh kube login`, one that is gone says so.
- **Edit kubeconfig…** (in Local kubeconfigs, or *Edit its kubeconfig…* on a
  cluster) opens the file here, colour-coded, beside suggestions to copy or
  insert at the cursor: a cluster, user and context together, another
  context, a user through Teleport (`tsh kube credentials`), EKS, GKE, a
  client certificate, skipping TLS for a lab, `current-context`. *Check* and
  *Save* have `kubectl config view` read it first — a YAML mistake is shown
  with its line — and a context naming a cluster or user the file doesn't
  have is said as well. Only the kubeconfig files ServerLife reads can be
  edited; the old one is kept as `<file>.serverlife-backup`.
- **The default kubeconfig is read automatically** — `$KUBECONFIG` if set
  (which, like `PATH`, can already name several files), otherwise
  `~/.kube/config` — so the common case needs nothing added by hand.
  *Add a kubeconfig…*, at the bottom of the Kubernetes group, is for extra
  files beyond that default.
- **A cluster's own tree**: click a context row to expand its namespaces,
  then a namespace to see its pods. Click a pod to exec straight in beside
  the pane you're already looking at (double-click for a tab of its own);
  right-click for logs (including a crashed container's *previous* logs),
  YAML (viewable, editable, exportable), delete, and port-forwarding. Any
  port-forwards running on that cluster show inline the moment it's
  expanded — no need to open the full browser just to see what's live.
- **A namespace you can use but not list**: a role scoped to one namespace
  can't list namespaces, so the tree has nothing to show. *Type a
  namespace…* at the foot of the tree (and in the full browser's Namespace
  dropdown) opens one by name; it's remembered for that context and offered
  beside the listed ones next time, along with the kubeconfig context's own
  default namespace. A cluster that lists none opens straight into that one.

### The full cluster browser

The ⤢ button on a context row (or its right-click menu) opens every resource
kind the cluster actually has — `kubectl api-resources` is asked, not a fixed
list, so a CRD installed yesterday needs no app update to browse today.
Categorised into Workloads, Config, Network, Storage, Access Control,
Cluster and Custom Resources, with a kind filter box once there are a lot of
them.

- **Which cloud it is on.** A small outlined badge beside the ☸ — **EKS**,
  **GKE**, **AKS**, or a local cluster (minikube, kind, Docker Desktop, k3s) —
  on every Kubernetes row, from the cheapest evidence that says so: the
  kubeconfig (an EKS or AKS endpoint, EKS's ARN and GKE's `gke_…` context
  names, the `aws eks get-token`, `gke-gcloud-auth-plugin` or `kubelogin`
  plugin), Teleport's labels (`teleport.dev/cloud`, `cloud`, tags copied in as
  `aws/…`, `gcp/…`, `azure/…`), and the cluster itself once opened (its nodes'
  `providerID` and labels, and a `-eks-` or `-gke.` server version), which is
  remembered for next time. A badge from the name alone (`prod-eks`) is dashed:
  a guess until the cluster is opened. Hover it for the region, account,
  project or resource group, and where it was found. **Connecting asks the
  cluster**: expanding a cluster, opening its browser or logging in to it runs
  one `kubectl version` (and reads the nodes only if that is not enough), once
  a run — so a cluster reached only through Teleport, with no labels, gets its
  badge the first time it is used, and keeps it. Nothing is asked on a timer,
  so a per-session-MFA cluster is only asked when you are using it anyway.
- **Set the cloud by hand**: right-click a Kubernetes row → *Cloud* → Amazon
  EKS, Google GKE, Azure AKS or a local one. What you set wins over detection
  (the badge says *set by you*); *Details — region, account…* adds what the
  console link needs (EKS region and account, GKE project and location, AKS
  subscription and resource group); *Detect automatically* forgets it. The
  Cloud view offers *Mark it as* EKS, GKE or AKS when nothing identified it.
- **☁ Cloud**, in the browser's list beside Helm and 3D, shows what people go
  to their cloud's console for but can read from the Kubernetes API —
  read-only:
  - **Node groups and pools**: EKS managed node groups, Karpenter, Auto Mode
    and Fargate; GKE node pools (Spot, preemptible, Autopilot); AKS agent pools
    with system/user mode and Spot — each with ready nodes, machine types,
    capacity type, zones and kubelet version. Click one for its nodes.
  - **Workload identity**: service accounts mapped to a cloud identity — IRSA
    role ARNs on EKS, Google service accounts on GKE, Azure client IDs on AKS.
  - **IAM → Kubernetes** on EKS: the `kube-system/aws-auth` mappings of IAM
    roles and users to Kubernetes users and groups, or a note that the cluster
    uses access entries (which live in the AWS API) when there is none.
  - **Open in the console**: the cluster's page in the AWS, Google Cloud or
    Azure console, when its region, project or resource group is known.
  A list your role may not read is said as such — through Teleport an empty
  node list is often a role that cannot see nodes, not an empty cluster.
- **Overview** is the landing page: node/namespace counts, pods by phase (each
  clickable to the list behind it), and `kubectl top`'s own numbers for nodes
  and the busiest pods — not just a blank "pick something on the left."
- **Every list** has sortable, resizable columns (click a header to sort,
  drag its edge to resize — remembered next time) and a filter box. A
  **Namespace** row's name is clickable — "Switch into it" scopes the
  namespace selector above and jumps straight to that namespace's Pods, the
  same as clicking "Switch into it" on its row or right-click menu.
- **"My access"** answers "what can I actually do here" without guessing: who
  the cluster (or, where it refuses to say, your Teleport login) sees you as,
  and a `kubectl auth can-i` grid across the resources and verbs people
  actually touch, plus a box to ask any one of your own — with suggestions
  for the resource field drawn from what this cluster actually has, not a
  blank box you have to already know the answer to fill in.
- **YAML, viewed, edited and exported**: "View YAML" opens it editable; a
  "Preview the diff" checkbox (off by default — a quick Apply doesn't need
  an extra step in front of it, but it's there when you want to see exactly
  what would change first) and "Export YAML…" saves it to a file.
- **Details**, beside View YAML and Describe: conditions, owners (each one
  clickable — straight to that resource's own Details: a Pod to its
  ReplicaSet, that to its Deployment, a Service to its Endpoints, a claim
  to the volume it's bound to), container status and volume mounts on a
  Pod, and the resource's own recent events — the parts View YAML already
  shows as one undifferentiated document, told apart.
- **Every list updates on its own now.** A watch for fast adds and
  changes, underneath it a slower periodic refresh for the one thing a
  watch can never say by itself — that something was deleted. `kubectl`'s
  own watch output has no signal for that at all, only for what is still
  there to describe, so a removal shows up within that refresh's own
  interval (seconds, not instant) rather than never. A cluster or role
  that refuses `-w` still works, just on that same slower cadence instead.
- **A CRD's own columns.** Its `additionalPrinterColumns`, if it declares
  any, appear as real columns on that kind's own list — not just
  Name/Status/Detail/Age, the same as `kubectl get` itself would show.
- **Resource usage, with a trend beside it.** The Overview's own
  `kubectl top` numbers for nodes and the busiest pods now carry a small
  sparkline, polled here rather than read from a metrics backend of its
  own — a node's against its real percent of capacity, a pod's against
  its own recent high (pods have no fixed baseline to read a percentage
  against the way a node does).
- **Details grows with what it's looking at**: a Pod's own Details adds
  **Resources** — each container's requests and limits beside its actual
  usage right now; a Node's adds **Capacity / allocatable**, and flags a
  pressure condition (`MemoryPressure` and the like) in red rather than
  listing it the same as every other condition; a Namespace's adds its
  own **Resource quotas** and **Limit ranges**, used/hard and defaults
  at a glance, without opening either kind's own list to look.
- **+ New**, in the browser's own toolbar: **Apply YAML…** for a blank
  manifest (the same apply machinery, just not tied to an existing
  resource); **New Namespace…**, a bare name, nothing more to fill in;
  **New Pod…** — name, namespace (with a "create it if missing" box),
  image (defaults to `nginx:latest`) and an optional container port — a
  disposable test pod without hand-writing YAML, deliberately not a
  Deployment: a bare pod has no restart guarantees, which is exactly
  what makes it the simpler, disposable kind for a quick test.
- **Nodes** get Cordon and Drain buttons, same defaults `kubectl drain`
  itself uses (DaemonSet pods skipped, emptyDir volumes discarded).
- **A command bar**, fixed at the bottom: `:kind` jumps straight to a
  resource kind (fuzzy-matched, same as the sidebar's own kind filter),
  `/text` (or bare text) sets the row filter — the same state the
  sidebar's own filter box already drives, just a second way in. While
  the browser has focus and no text field is being typed into, `↑`/`↓`
  move a highlighted row, and `Enter`/`d` (Details), `l` (Logs, for a
  single-container Pod) and `x` (Delete) act on it.
- **A label selector**, beside the namespace picker — the same `-l`
  this list's own "Pods" button already uses internally, now free text
  you can type yourself. **Pick several…** turns the single namespace
  dropdown into a checklist: more than one namespace fetches every
  namespace and narrows to the ones checked, client-side (`kubectl` has
  no way to ask for several specific namespaces in one call).
- **Export…**, beside the row filter — the rows actually shown right now
  (after both filters), or only the ticked ones, as **CSV** (the table as
  shown) or as Kubernetes **JSON** or **YAML**: a `kind: List` of the full
  objects, the same document `kubectl get -o json|yaml` writes, so
  `kubectl apply -f` takes it back. *Ready to apply elsewhere* leaves out
  what the API server sets itself — `status`, `uid`, `resourceVersion`,
  `managedFields`, a Service's `clusterIP` and the like. For **Pods** it also
  drops what ties one to where it ran: `nodeName` (on another cluster a Pod
  pinned to a missing node waits Pending forever), the service-account token
  volume this cluster injected, and any debug containers. A Pod that a
  ReplicaSet, StatefulSet, DaemonSet or Job owns would land as a standalone
  copy nothing manages, so the export says so and names the owner to export
  instead. Whatever it uses — its namespace, ServiceAccount, ConfigMaps and
  Secrets — has to exist in the cluster it is applied to.
- **Clicking a workload's name** — a Deployment, StatefulSet, DaemonSet or
  ReplicaSet, or a Service — opens the pods it owns (or routes to), the Pods
  list scoped to its own label selector; *Show all Pods* goes back.
- **The list only changes when the cluster does.** It keeps itself current
  (a watch, and a re-read every 30 seconds — 10 for Events), but the table is
  only redrawn when a row actually changed, and a re-read never clears the
  filter, the ticked rows or the row you were on.
- **Stalled-rollout alerts**, for as long as a cluster's own browser tab
  stays open: a Deployment/StatefulSet short of its desired replicas for
  more than five minutes straight (not on its first minute of rolling
  out, which is normal) — a toast, and when the window isn't focused, a
  desktop notification too, the same mechanism a scheduled run's own
  completion already uses. Checked only while a tab for that cluster is
  open, not an always-on background monitor for a cluster nobody is
  looking at. A pod Kubernetes itself has already labeled
  `CrashLoopBackOff` does **not** pop up — it used to, but a flapping
  pod leaves and re-enters that state on every restart, so it kept
  re-popping roughly every poll on a cluster with even one flapping pod,
  let alone several on a shared one; it is still visible wherever a
  pod's own status already shows it, just without the interruption.
- **Search open clusters…** and **Compare…**, in the toolbar — look for
  a resource by name across every cluster that already has a browser
  tab open (not every cluster reachable — that would mean quietly
  opening new connections in the background), or diff one resource's
  YAML between two of those tabs, line by line.

### Workload actions

The buttons every Kubernetes client has, on a row's right-click menu in the
full browser. Each one shows the exact `kubectl` command it is about to run,
and asks before running anything that changes the cluster.

- **Scale…** — a Deployment, StatefulSet or ReplicaSet to a number of
  replicas (`kubectl scale`).
- **Rollout** — on a Deployment, StatefulSet or DaemonSet: *Restart*,
  *Status*, and *History / Undo…*, which lists the revisions and rolls back
  to the one picked. A Deployment also has *Pause* and *Resume*.
- **Edit containers…** — a workload's containers (Deployment, StatefulSet,
  DaemonSet, ReplicaSet, Job, CronJob): change an image, add or remove
  environment variables, set resource requests and limits, without writing
  YAML. It starts from what each container has now.
- **CronJobs**: *Trigger now* runs one at once as a Job of its own
  (`kubectl create job --from=cronjob/…`); *Suspend* and *Resume* stop and
  restart its schedule, and the row says when one is suspended.
- **Pods**: *Evict…* goes through the Eviction API, the way a drain does,
  so a PodDisruptionBudget is respected; *Force delete…* removes a pod stuck
  in Terminating without waiting for its node (`--grace-period=0 --force`).
- **Several at once**: tick rows and *Delete selected…* deletes them in one
  go.
- **+ New** in the toolbar has *New Deployment…*, *New Service…*,
  *New ConfigMap…* and *New Secret…* beside *Apply YAML…*: a few fields
  become a complete manifest, shown as YAML before it is applied the same
  way any other YAML is. A Secret's values are written as `stringData`, so
  nothing in the form is base64.

### Debugging

Reachable the same two ways exec and logs already are — right-click a pod in
the sidebar tree, or in the full browser's own Pods list — plus a couple of
new places of their own:

- **Attach**, beside **Exec** on a pod's menu: `kubectl attach -i`, into the
  container's own already-running process rather than a fresh shell beside
  it. No TTY is requested — kubectl itself refuses one outright on a
  container that was not started with one — so this streams its output and
  passes input through either way, interactive or not.
- **Debug container…**, on the same menu (and the full browser's "⋯" menu):
  an ephemeral debug container dropped into the pod, for one with no shell
  of its own or whose image has nothing worth execing into. Asks for an
  image first — defaults to `nicolaka/netshoot:latest` (curl, dig, tcpdump,
  a real shell), editable to anything else.
- **Node shell…**, on a Node's row in the full cluster browser: the same
  idea, a privileged debug pod scheduled onto that node, its root filesystem
  mounted at `/host`. Run `chroot /host` once inside for a true node shell —
  not done automatically, since not every debug image carries `chroot`.
- **Logs (all pods)…**, on any row with its own Pods button (Deployment,
  StatefulSet, DaemonSet, ReplicaSet, Service): every pod that resource
  selects, tailed and interleaved in one terminal, each line prefixed with
  its pod and container — `kubectl logs`'s own `-l`/`--prefix`, not a
  separate tool. Tolerates pods coming and going, by design.
- **Open log viewer…** (one pod) and **Open log viewer (all pods)…** (a
  selector, same rows as above): the same logs, but as a searchable list
  instead of a terminal — a filter box (plain text, or a regex toggle), a
  live line count, **Follow** to keep it pinned to the bottom, **Stop**/
  **Restart**, and **Download…** to save everything held so far to a file,
  regardless of what the filter is currently hiding. Keeps the most recent
  20,000 lines; a session left running longer than that says so rather than
  growing without bound.

### Security and RBAC

- **Ask/check as**, on "My access": "Can I…?" and the rights grid both
  take an optional user and groups to impersonate (`--as`/`--as-group`,
  the same flags `kubectl` itself uses) — blank means yourself, same as
  before. Through Teleport, impersonating anyone at all first needs the
  *Teleport* role you connected with to allow it, a separate gate from
  Kubernetes RBAC — refused there, the question comes back "could not
  ask" with the real reason, not a wrong yes or no. Where it *is*
  allowed, how closely the answer matches asking the same question
  outside Teleport still depends on how that cluster's own Teleport
  integration is set up — review it the same way you'd review any answer
  this matters for, rather than take it as the last word.
- **Who can do this?**, beside it: the reverse of "Can I…?" — not "can I,"
  but every subject some RoleBinding or ClusterRoleBinding *already*
  grants a verb/resource to, found by walking every binding to its Role
  or ClusterRole and checking its rules the same way the API server
  would (wildcards included). Across every namespace by default, since a
  reverse lookup has no "just mine" to default to the way a forward
  can-i does.
- **Roles and Bindings browse and edit like anything else** — View YAML
  (editable, with a diff before apply), Describe, Delete, all already
  generic — and Details now knows their shape specifically: a
  Role/ClusterRole's own **Rules** (apiGroups/resources/resourceNames/
  verbs, one row per rule), a RoleBinding/ClusterRoleBinding's **Role
  ref** (clickable, straight to that Role's own Details) and **Subjects**.
- **New Role…, New ClusterRole…, New RoleBinding…, New ClusterRoleBinding…**,
  in **+ New**: a **Common need** preset (read-only, exec into pods,
  manage Deployments/Pods, manage Config/Secrets, full access…) fills in
  the rules for you — editable afterward, and "Custom" leaves the box
  blank for anything a preset doesn't cover. Every one of these forms
  says so plainly: review the generated rules before relying on this
  anywhere production — a role broader than intended is a real security
  risk, and a typo in an apiGroup or resource name fails silently rather
  than with an error, the same diff-before-apply step every other create
  form already goes through is exactly where to catch that.
- **Test**, beside a ServiceAccount subject in a RoleBinding/
  ClusterRoleBinding's own **Subjects** (not shown for User/Group
  subjects — see below): runs a real, short-lived pod *in the cluster*
  as that ServiceAccount, which asks `SelfSubjectAccessReview` about
  itself for a sample of the bound Role's own rules, then deletes the
  pod — a genuine answer from Kubernetes' own authorizer, not a reading
  of the rule text. This sidesteps the Teleport impersonation gate above
  entirely: the pod's own mounted token already *is* that identity, so
  nothing needs to be asked to impersonate anyone. Asks first — this
  creates a real, if short-lived, resource in the cluster. There is no
  equivalent one-click test for a User/Group subject yet: it has no
  in-cluster credential of its own to run a pod as, and testing it
  properly needs either a Teleport-side identity able to impersonate it
  (see **Ask/check as** above, and its own caveat) or a dedicated Machine
  ID identity minted for exactly that subject — not implemented here.
- **View decoded…**, on a Secret: its `data` keys, decoded for reading
  and editing — View YAML still shows the raw base64, which is correct
  but not readable. Saving never encodes anything by hand; a merge
  patch's `stringData` does that through the API server itself, the same
  reasoning the Secret create form's own `stringData` already uses.
- **Scan cluster…**, in the full browser's own toolbar: a
  [Popeye](https://github.com/derailed/popeye) lint — untagged images,
  containers with no resource limits or probes, pods running as root, no
  NetworkPolicy, and more — scored and graded, by resource kind. Needs
  Popeye installed (picked up automatically, same as k9s/helm); scoped to
  one namespace or every namespace. This is a configuration lint, not a
  vulnerability scanner: `kube-bench` (checks node-local files — it has
  to run as a Job *inside* the cluster, not something reachable from a
  desktop app the way Popeye is) and image CVE scanning (needs a
  registry-aware scanner of its own) are a different shape of
  integration and are out of scope here on purpose, not a gap. `kube-bench`
  is still picked up as an installed-or-not ecosystem tool, for what
  that's worth on its own.

### Editing

- **Every YAML view (View YAML, Apply YAML…, a create form's preview,
  Edit YAML on a running Pod) is a real editor now**, not a plain text
  box: syntax highlighting always; when it's also editable, two more
  things ask the cluster itself rather than a bundled copy of its schema
  (which would go stale the moment a CRD changed) —
  - **Validation**, a few hundred milliseconds after you stop typing: a
    server-side dry-run apply, nothing persisted, so an unknown field or
    a wrong type is underlined (and shown in the gutter) before you ever
    click Apply, with the cluster's own error message.
  - **Autocomplete**, for field names: typing inside `spec:`, `metadata:`
    and so on offers that kind's own real fields, sourced from `kubectl
    explain <kind> --recursive` — once `kind`/`apiVersion` are filled in,
    including for CRDs. Indentation-based, not a full YAML parse — "good
    enough," the same standard the plain textarea this replaces always
    held itself to.
- **Build from Kustomization…**, beside **Apply YAML…**: picks a local
  directory and runs `kubectl kustomize` on it (built into kubectl
  itself — nothing extra to install), then opens the rendered manifest
  in the same editor for review, optional diff and apply, rather than a
  blind `apply -k`.
- **Flux and Argo CD CRDs get their own GitOps category** instead of
  piling into generic Custom Resources, and a real status instead of
  silence: a Flux kind's own `Ready` condition (with the reason, when
  it's not), or an Argo CD `Application`'s sync and health status. This
  is recognition, not management — no reconciliation or sync button here,
  since that would mean embedding the Flux/Argo CD CLIs themselves, a
  different and much bigger integration than "what does this already
  say about itself."

### Helm releases

A fixed entry in the cluster browser's own nav list, since Helm releases
never show up in `kubectl api-resources`. Lists every release (sortable,
resizable, same as everything else) with Values, History (each revision a
Rollback away), **Test** (`helm test`, the chart's own tests against the
deployed release, with logs), Uninstall, and Export (values or the full
rendered manifest). **Install release…** takes either a repo chart (repo
name + URL + chart name — the repo is added for you) or a local chart
path, with an optional values YAML and a dry-run checkbox that defaults
checked. Reachable in one click from a cluster's right-click menu too —
"Manage Helm releases…" opens the browser straight on this list.

- **README** and **Render templates…**, beside the chart fields in
  Install/Upgrade: `helm show readme` as plain text, and `helm template`
  rendered in the same highlighted editor Section 6 added — both purely
  local, nothing sent to the cluster.
- **A values form**, when the chart actually has a `values.schema.json`
  (most don't) — one input per scalar field, pre-filled from the
  schema's own defaults. It's a generator, not a live two-way editor:
  **Use these values** turns the current form into a fresh values YAML
  block in the textarea above, which the real YAML editor then takes
  over from — safer than trying to parse arbitrary hand-edited YAML back
  into form fields and merge edits in.
- **Diff from current…**, on each row in History: that revision's
  values against the release's current ones, line by line (no `helm
  diff` plugin assumed installed).
- Searching Artifact Hub (rather than only the local repos already
  added) is out of scope on purpose: it is the one thing in all of
  KubeLife that would mean calling a public third-party API over the
  network, where everything else only ever talks to the
  cluster/kubectl/helm installed locally.

### Port-forwarding

Right-click a Pod, Service, Deployment, StatefulSet or DaemonSet — in the
sidebar tree, the full browser's rows, or the 3D view's own Service popup —
for **Port-forward…**: a remote port and an optional local one (blank lets
`kubectl` pick an open port itself). Once running, it's visible everywhere,
not just wherever you started it:

- the sidebar's own cluster row shows a small **⇄ N** badge even collapsed,
  and the inline list once expanded, each with Copy and Stop right there;
- the full browser's toolbar has its own **⇄ N active** button, listing
  every forward on that cluster;
- stopping one — from any of these, or the "running on :PORT" submenu a
  resource's own port-forward menu item becomes — asks for confirmation
  first: it's live traffic something may be depending on mid-click, not a
  free action to undo.

### The 3D view

A cluster, as a city: namespaces are districts, pods are buildings that
breathe while running — faster and a touch bigger the busier `kubectl top`
says they are — and flash red when crashing. Deployments are pillars
coloured by their own ready/desired ratio; Services are fixed-colour
beacons. Click a building for its details (and, for a Service, a
port-forward); a search box dims everything that doesn't match and flies
the camera to the first hit; a kind filter narrows to just Pods, Deployments
or Services; a building-style picker (Blocks, Cylinders, Crystals) is purely
a look, not a meaning — colour and height always mean the same thing.

Opened from **🧊 3D view** in the cluster browser's own nav list (or a
context's right-click menu) — never a popup, which is also why arrow keys
actually work here: drag to rotate/pan, scroll or +/- to zoom, and the
arrow keys rotate/tilt the moment the view has opened, no click needed
first. The namespace selector above scopes it the same way it scopes every
other list in the browser. Clicking a kind in the nav list that the 3D view
actually renders (Pod, Deployment, Service) filters it in place instead of
leaving; clicking anything else asks first, since there's nothing 3D could
show for a ConfigMap or a Node anyway.

### Mapping a Teleport group to a ClusterRole

Teleport's Kubernetes Service reaches a cluster *as* the Kubernetes groups a
user's Teleport role allows — `spec.allow.kubernetes_groups` — and a group
has no permissions of its own until a binding in the cluster gives it a role.
**+ New → Map a Teleport group to a ClusterRole…** in the cluster browser
does both halves:

1. **In this cluster** — name the group, pick a ClusterRole (`view`, `edit`,
   `admin` and `cluster-admin` are explained; the cluster's own are listed
   after them) and where it applies: the whole cluster, as a
   ClusterRoleBinding, or only chosen namespaces, as a RoleBinding in each
   that grants the same ClusterRole there. The YAML and the exact
   `kubectl apply` are shown; *Apply the binding* checks you may create
   bindings, asks, and applies.
2. **In Teleport** — the role to go with it: the group under
   `spec.allow.kubernetes_groups`, `kubernetes_labels` set to this cluster's
   own Teleport labels (or `'*': '*'`, flagged, when none are known) and, for
   chosen namespaces, `kubernetes_resources` limited to them. *Copy role YAML*
   or *Export role.yaml…*, then `tctl create -f` it and give the role to the
   people who should have it — on their user, through your SSO connector's
   mapping, or in an access request. ServerLife does not change Teleport roles
   itself.

### Reopening after a restart

A cluster browser tab, and a pod's exec or logs pane, come back with the rest
of the layout when ServerLife reopens — as themselves, on the view they were
showing, not as plain local shells. Each is checked first:

- **Still in the kubeconfig**: it reopens as it was.
- **Gone from the kubeconfig, but still offered by its Teleport cluster** —
  `tsh logout` takes the contexts it wrote with it — ServerLife asks *Log in
  to a Kubernetes cluster?* and runs `tsh kube login` before reopening. It
  asks once per cluster, however many tabs were open on it.
- **Behind a Teleport login that has lapsed**, or **no longer offered** (its
  agent gone, or your access to it), or a local context that was deleted: it
  says so instead of reopening into an error.
- **A pod's exec or logs pane** reopens only if that pod is still there:
  pods are replaced under new names, and a shell in a different pod would
  not be the one you had open.

### Turning it off

Kubernetes support is **on by default**, and turning it off is one setting —
**Settings → KubeLife → "Enable Kubernetes support (KubeLife)"** — not a
dozen. Off, there is no Kubernetes group in Resources, no All/SSH/K8s filter,
no kube entry in Add Server or quick connect, no kube kind in access
requests, and no Kubernetes menu item: nothing. This is deliberate — someone
running ServerLife purely as an SSH and Teleport client should never see a
trace of a feature they do not use, not even a greyed-out one. Turning it
back off removes all of it immediately, with nothing left behind to clean up.

## Windows

*Session → New Window* (`⌘⌥N`), or the button on the start page. Each window
has its own tabs, panes, sidebar and file browsers; connections are shared, so
a host already dialled is not dialled twice.

Every window's layout is remembered on its own, and reopening the app offers
them all back at once — the restore prompt says how many more windows come with
it, and one answer brings back the lot, each landing in the window it came
from. A window closed on purpose does not come back. Windows take their title
from what is open in them, so the Window menu lists `web-01, db-02` rather than
three entries called ServerLife.

## S3

Register buckets under *Saved → S3* and they appear as a source in every file
explorer, beside your sessions and the local machine.

Credentials come from one of four places:

| Source | What it uses |
|---|---|
| **Teleport** | An AWS app and IAM role via `tsh proxy aws` — per-session, audited, nothing stored |
| **AWS profile** | `~/.aws` as it already is: SSO, assumed roles, `credential_process`, static keys |
| **Environment** | `AWS_ACCESS_KEY_ID` and friends, optionally under a prefix |
| **Stored key** | Encrypted with the OS keychain; refused if the machine has none |

Browse the buckets the credentials can see and pick one rather than typing it;
the region is detected, and a bucket in another region corrects itself from the
header S3 sends back. Download, upload, delete, copy a key and re-tier objects.
Uploads choose a **storage class** — Standard through Deep Archive — defaulting
to whatever the bucket was registered with.

Signature V4 is implemented directly rather than pulling in the AWS SDK, and is
verified against AWS's published test vectors.

## Macros

Commands aimed at a host, under *Saved → Macros*. Where a snippet is text you
paste, a macro answers a question — "is the agent running", "what is filling
the disk" — so it carries a description and can run without a terminal open.

Forty-nine ship built in. **Teleport**: service status, agent health
(`teleport debug readyz` — connected and ready, not merely running; newer
agents only), follow the agent log, errors in the last hour, whether the agent
can reach its proxy (the address from `/etc/teleport.yaml`, pinged), clock sync
(a drifted clock fails certificate checks), version, `tsh status`, **Teleport
ssh session status** (`teleport status`: the session id, cluster, host UUID and
where you connected from — only inside a Teleport SSH session), config,
restart, and `tsh ls`, `tsh ssh` and `tsh scp` for the local shell. **System**: disk usage with
inodes, largest directories in `/var`, memory and load, top processes,
listening ports, recent errors, who is logged in, addresses and routes, OS and
kernel, pending reboot. **Beams**, offered only in a beam's session: the
services `beamctl` runs and each one's details and logs, starting one on port
8080 (the one a beam can publish), restarting and stopping, publishing HTTP or
TCP and unpublishing, freezing, thawing, attaching to and waiting on a service,
stopping one and removing it from the list, the beam's identity and what it can
reach (apps, databases, GitHub orgs, SSH nodes, Kubernetes), the AI gateway's
settings (keys masked) and a test call to it, the examples a beam ships with,
starting a new Phase build (`tsh phase add`), and — in a Phase build console —
saving the build (`tsh phase snapshot`), saving and ending it (`--final`) and
forking it into a new Phase (`--fork`). Those that create or end something are
**careful**: they say what running them costs and ask first. They live in code rather than being copied into your
settings, so they improve between releases — hide any you do not want and
restore them later.

- **Every session pane has a ▶ button** in its header that drops down the macro
  list, grouped by category, and runs the one you pick on that host. `⌘⇧R`
  opens the same menu on the focused pane.
- **The list stays listed while it fits.** When the whole of it is taller than
  the window, the largest category folds into a single row — its name and how
  many it holds, opened by hovering or clicking — then the next largest, and
  only until the rest fits, so a short window folds the long categories and
  keeps the short ones open. A menu still too tall after that scrolls; no menu
  in the app runs off the top of the window any more.
- **Double-click** in the list sends a macro to the focused terminal.
- **New macro…, Restore built-ins, Export… and Import…** sit at the top of the
  list, where they can be reached without scrolling past every built-in.
- **Drag a macro** in the list to put it where you want it; the ▶ menu follows
  the same order, and it is kept in a backup. Dropped on a macro in another
  category, one of your own moves into that category. A built-in stays in its
  own — its category is part of the shipped set — so it moves only within it.
- With **nothing focused**, it offers to run on a host you pick and shows the
  output in a dialog.
- Right-click for *send to every pane*, *run on a host and show output*,
  *copy*, *edit* (built-ins duplicate first) and *hide/delete*.
- Macros that change something are marked **careful** and ask before running.
  Ones that follow a log are never run headless.
- **A `?` on every row** of the ▶ menu, with its own tooltip: what the macro is
  for, the command it runs, and whether it asks first, follows a log, is pasted
  without Enter, or has blanks to fill in. A separate hover target, so "what
  does this do" does not mean hovering the thing you have not decided to run.
- **Submenus open from the arrow**, not from the row. Every macro row both runs
  something and carries variations, so opening on hover threw a second panel
  under the pointer at each step down the list.
- **Where a macro can run** is part of the macro: **hosts and the local
  shell**, **hosts only**, or **the local shell only**. `sudo journalctl -fu
  teleport` is not something you run on a Mac and `brew upgrade` is not
  something you run on the server, so the ▶ menu offers only what fits the pane
  it was opened from, multi-exec leaves out anything local-only, and a pinned
  button never appears where its macro would not run. Set it in the macro
  editor, under the command.

  The built-ins are host commands — systemd, `journalctl`, `ss -tulpn` — so
  they say so; the three written to fall back to the BSD tools (disk usage,
  addresses and routes, OS and kernel) are marked for both. A macro of your own
  from before this existed is offered everywhere, as it was; a new one written
  from a pane's ▶ menu starts as whatever that pane is.

  Sending one somewhere it is not set for still works — the sidebar's
  double-click goes to whatever is focused — but it asks first, because the
  scope is a default about where a macro belongs rather than a lock.
- **Pin a macro as a button.** *Pin as a button* — from the macro's menu or its
  editor — puts it directly in every session header with an icon you choose,
  instead of two clicks into the ▶ menu. Each pin says where the *button*
  belongs: **every session and the local shell**, **host sessions only**, or
  **the local shell only** — narrowing the macro's own scope, never widening
  it. The scope can be changed later from either place.
- **Variables.** A command can leave blanks — `{{service}}` — filled in when it
  runs, so "restart a service" is one macro rather than twenty. Declare them in
  the editor, one per line:

  | Written as | Means |
  |---|---|
  | `service = teleport` | a default, so the macro still runs on one click |
  | `level = info \| warn \| error` | a list to pick from; mark the default with `*` |
  | `lines =` | no default, so it is always asked for |

  A `{{name}}` used in the command but never declared is treated as a blank
  with no default rather than left in as literal text. A macro whose blanks all
  have defaults runs straight away; one with an empty blank opens a dialog with
  the command previewed as you type. **Fill in variables…** in the macro's
  submenu opens that dialog either way, for the times you want to change a
  value that has a perfectly good default. Across multi-exec, the values are
  asked for once and the same ones go to every host.
- **The last entry in the ▶ menu writes a new macro**, because the moment you
  want one is the moment you have just typed the same command for the third
  time — and you are looking at that menu, not at the Saved tab.
- **Record a macro.** *Record a macro* — on a pane's right-click menu or at
  the bottom of the ▶ menu — and run the commands as usual. The header shows
  **● Stop recording** with a count. Each command is read off the screen as it
  stood when Enter was pressed, so what Tab completed and the Up arrow brought
  back are in it as they ran. A command typed but not yet run when you press
  Stop is kept as the last step, marked *typed, not run* — so a macro can end
  on a command you did not want to run while recording. Not recorded: keys typed into a full-screen
  program (vim, less, top), a line abandoned with Ctrl+C, and passwords, which
  are never on the screen. Stopping lists the steps to untick, edit or
  reorder — a line that looks like it holds a secret (`TOKEN=…`, `-p…`, an
  `Authorization:` header) is shown in red and left out unless ticked — with
  *Stop at the first step that fails* (the steps joined with `&&`), then the
  macro editor, filled in, with *Where it can run* set from the pane it was
  recorded in.
- **Multi-exec** has **Command**, **Macros**, **Recent runs** and **Scheduled**
  tabs, so a macro can run across every selected host with the same run-as
  login.

## Network and certificate tools

*Session → Network and Certificate Tools…* (`⌘⇧T`). One target — a host, `host:port` or URL —
and a set of tools against it, so several can be run in a row without retyping:

| Tool | What it tells you |
|---|---|
| Ping | Round-trip time and packet loss |
| Traceroute | The path packets take, hop by hop |
| DNS | A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, SOA, NAPTR, and PTR for an address — TTL shown for A/AAAA |
| Port check | Whether a TCP port accepts a connection, and how fast |
| TLS certificate | What the server presents, valid or not — the full chain, cipher, SANs, fingerprint, days left |
| HTTP | Status, timing, size, redirect chain and response headers |
| Whois | Registration for a domain or address |
| Teleport cluster | A proxy's `/webapi/ping`, laid out (below) |
| This machine | Local interfaces and resolvers |
| Subnet calculator (CIDR) | Network, netmask, wildcard mask, broadcast, usable range and size — and whether an address is inside |
| URL encode / decode | Text both encoded and decoded; a URL taken apart, query decoded |

**Most of these show the command they would run**, live, as the target and
options are typed — the same one `ping`, `nc` or `openssl` would be, so the
same check can be run by hand in a terminal, over a ticket, or on a box this
app has no session on at all. ***Copy command***, beside *Copy output* in
the footer, copies whichever one is showing. Windows gets the real
substitute where the usual tool isn't there by default: `Test-NetConnection`
for a port check or telnet probe, a three-line native PowerShell snippet for
a TLS certificate (`openssl` is noted as a fallback if it happens to be on
PATH), and a plain note on Whois, which carries no client at all. DNS's
`nslookup -type=X` needs none of this — it is spelled the same everywhere.
Nothing is shown for a check run **on** a host (below) — that command would
be for this machine, not what is actually happening over that session.

**This machine, and the three decoders below, get the command once a result
is back, not live** — there is nothing to preview before a certificate is
pasted or a result read. *This machine* gets `ifconfig`/`netstat -rn` (mac),
`ip addr`/`ip route` (linux) or `ipconfig /all`/`route print` (Windows); the
decoders' own commands are with them, further down.

**The subnet calculator** takes `10.0.0.0/16`, a netmask as `ifconfig` prints
it (`192.168.1.0 255.255.240.0`), an address with host bits set (it says which
network that address belongs to) or an IPv6 prefix. *Is this address in it?*
answers the allow-list question. A /31 and a /32 count every address as usable,
as RFC 3021 has it.

The port check is one host at a time with a 32-port ceiling — a reachability
check, not a scanner. Nothing runs through a shell: external commands get an
argument array and every target is validated first.

**A port has three answers, not two.** *open* is a connection that was
accepted. *refused* means the host answered and nothing is listening on that
port — something is there. *no answer* means nothing came back before the
timeout, which is a firewall dropping the packet, or an address with nothing
at it. The distinction is the whole diagnosis: a refusal is a service to
start, silence is a rule to change.

**Ping, traceroute and the port check can all be forced onto one IP family** —
a dual-stack host being flaky over IPv6 but not IPv4 (or the other way round)
is exactly the kind of question these exist to answer, and otherwise there was
no way to ask it here. Only when running from this machine; the on-a-host
versions below are a different implementation and do not take it yet.

**DNS can be asked through a specific nameserver** instead of this machine's
own resolver — "is this propagation, or is my resolver just stale" is one of
the most common real DNS questions. The copied `nslookup` command names the
same server, so what is shown and what is pasted agree; without one, both ask
whatever this machine itself would.

**TLS can start in plaintext and upgrade** — STARTTLS on SMTP (25/587), IMAP
(143) or POP3 (110), where the server speaks cleartext until asked to switch.
Without naming the protocol, the check assumes the port is already TLS, which
is wrong for all three and would just read as a hung connection.

**Curl can be pointed at a specific address for one request** (`--resolve`,
the same thing a DNS cutover would change, asked without touching DNS or
`/etc/hosts`), and can present a CA bundle or a client certificate and key —
for an internal proxy signed by a private CA, or a service that wants mutual
TLS. `-k` is still there for when neither applies.

**Teleport cluster information** — also on *Teleport → Cluster Information…*
and the **Cluster info** button on any profile. Reads `/webapi/ping`, which
needs no credentials, and lays out the cluster name, version, minimum client,
edition and FIPS mode; managed-update settings; the auth connector in play with
its display name, second factor, passwordless support and session TTL; and
every proxy listener including Kubernetes and database addresses and whether
TLS routing is on. The raw JSON is one click away.

### Running them on a host

The question is usually not what your laptop can reach — it is what *that
server* can reach. **Run on** at the top of the window switches between this
machine and any session that is open, and the network icon on a session's own
header opens the tools already pointed at that host.

Five checks work there. Three need nothing at all installed on the far side:

| | |
|---|---|
| **Port check** | The server is asked to open the connection, over the session that is already authenticated (`ssh -W`). The answer comes from its own network stack, and a service that announces itself hands back its banner — `SSH-2.0-OpenSSH_9.6p1` — as free evidence of *what* is listening |
| **HTTP request (curl)** | Sent through a SOCKS proxy over the session, with `--socks5-hostname`, so the name is resolved on the host as well. A request to `169.254.169.254` therefore reaches *its* metadata service, not yours |
| **That host** | Its addresses, routes and resolvers, from `ip` and `/etc/resolv.conf` |

Two more do need a tool, and get one anyway, because they are the first two
things anyone reaches for:

| | |
|---|---|
| **Ping** | `ping` is on almost every box. The output is shown as the host printed it — including a run that lost every packet, which is an answer. Worth knowing: a container without `cap_net_raw` gets "Operation not permitted", and plenty of networks drop ICMP while passing TCP perfectly well, so a failed ping is not a failed network |
| **Traceroute** | The name everyone knows is the one least often installed. `traceroute` is used where it exists, then `tracepath` (iputils, no root needed), then `mtr --report`. The result says which answered it |

Both are greyed with the reason when the host has none of them, rather than
failing when pressed — and the reason comes with the command that would fix
it. The remaining tools — DNS, TLS, whois — are still marked *from this
machine only*: they would need their output parsed per distribution, which is
a different piece of work.

The icon sits on every session's header, and can be turned off in Settings for
anyone whose header is busy enough already — the tools are still on `⌘⇧T`, with
the same **Run on** selector.

**What the host has** is read once per session, in a single command, and shown
under the selector: the distribution, what is installed, and what is missing
with the exact command that would fix it (`sudo apt install traceroute`) taken
from the package manager the server profile already detects. One command rather
than one per tool, because on a per-session-MFA node every exec is a prompt and
on any Teleport node it is an audit entry. *Re-check* asks again, for after you
have installed something.

A session dialled with `tsh ssh`, or a beam, cannot forward — so a port check
there falls back to what the host has: the `bash` `/dev/tcp` builtin, then `nc`
(whose flags differ between the OpenBSD, nmap and busybox versions, which is
why the probe records which one it found), then `python3`. Every port goes in
one command rather than one each, since on a per-session-MFA node that is the
difference between one prompt and five.

> A check run on a host runs *on someone else's machine*: it appears in that
> cluster's audit log, and the same 32-port ceiling applies as locally. It is a
> reachability question, not a scanner.

### Decoding certificates and tokens

Three more in the same list take something pasted rather than a target —
the credentials met while working out why a login is refused:

| | |
|---|---|
| **SSH certificate** | A `-cert.pub` line, as `ssh-keygen -L` shows it: user or host, key ID, principals (the logins it allows), validity, serial, critical options, extensions — Teleport's roles and traits among them — and the signing CA's fingerprint, to compare with `TrustedUserCAKeys`. *Use a certificate tsh issued…* lists the ones under your Teleport homes, newest first |
| **JWT** | Header and claims, the times in words, and whether it has expired. Says when it is a Teleport application token or a JWT-SVID |
| **SPIFFE SVID** | An X.509-SVID: its SPIFFE ID, subject, issuer, validity, key and SANs, checked against the SPIFFE rules — one URI SAN, a `spiffe://` ID with a lower-case trust domain and a path, a leaf that is not a CA. A chain pasted after it is checked link by link |

They are also a right-click **Decode** submenu. In a terminal it decodes what
is selected — a token in a log line, a certificate `cat`ed on a server; on a
Teleport cluster's heading, *SSH certificate* reads your own certificate for
that cluster.

**A certificate tsh issued shows where it lives**: a *File* card with its
path under `keys/<proxy>/<user>-ssh/` in your Teleport home (`~/.tsh`,
`%USERPROFILE%\.tsh` on Windows, or any other tsh home you have added), with the
private key and the cluster's other credentials beside it. *Show in Finder*
on macOS and *Show in Explorer* on Windows open that folder with the file
selected. On Linux, *Show in folder* does the same when your file manager
supports it, and *Open folder* beside it opens the folder in any file manager.
A pasted line that matches one of tsh's files gets the same card, even when it
wrapped in the terminal.

**Browse…** beside the box decodes a file instead of a paste: a `-cert.pub`,
a token saved to a file, or an SVID's PEM. For an SSH certificate the dialog
opens in `~/.tsh/keys`. A decoded file gets the same *File* card.

**Each decoder gets a real command to run the same check by hand**, beside
its result: an SSH certificate with a known file gets `ssh-keygen -L -f` on
it — nothing is shown for one pasted with no matching file, since there is
no file to point the command at (ssh-keygen also ships as a Windows
optional feature, not on by default — noted when it matters). A JWT gets a
`python3` one-liner decoding its payload segment directly, sidestepping
base64url's missing padding, which trips up `base64 | jq` differently on
BSD and GNU. An SVID gets `openssl x509 -noout -text` as a heredoc, built
from the certificate as re-serialized — no file needed. Each has its own
**Copy** button, and the footer's *Copy command* reaches all three too,
remembering the last one run until the tool is run again.

Each result opens **Readable** — a one-line summary, then cards: for an SSH
certificate the logins, validity in local time, roles and traits as tags (a
long list shows its first dozen and *+N more*), what it permits and the device
it is bound to. **Raw** switches to the form other tools print — `ssh-keygen
-L`'s layout, a JWT's JSON and encoded parts, an SVID's PEM — and the choice is
remembered. *Copy raw* copies it.

Everything is worked out on this machine and nothing is sent. Signatures are
reported, not verified — that needs the issuer's key or CA, which a paste does
not come with. And because these are credentials, decoder and URL runs are
kept out of the recent list.

### HTTP requests (curl)

A full request, built in a form and run through **curl itself** — the same
proxy variables, the same CA store, the same HTTP/2 as your own `curl`, and a
command line you can paste elsewhere. Method, headers one per line, a body sent
exactly as typed, a content type, and either a bearer token or basic auth.

The command is shown as it will run, built from the same argv the request uses
so the preview and the call cannot drift apart. Nothing goes near a shell: a
header containing `$(…)` is one argument, not an opportunity.

The response comes back as a status line with timing and size, the headers, and
the body — pretty-printed when it is JSON, because an API's error message is
usually in there and one line of minified JSON hides it. A redirect chain is
kept, hop by hop, since "which hop set that cookie" is a question this is used
to answer.

**Examples…** fills in the typical shapes rather than explaining them: read a
JSON API, send JSON, send a form, PATCH one field, DELETE, fire a webhook,
check a health endpoint, HEAD for headers only, and a Teleport proxy's
`/webapi/ping` with your own proxy already in the URL. Every other tool has its
own examples on the same button — the Teleport port set for a port check, a
reverse lookup for DNS, twenty packets for a ping that flaps.

> A token in a command line is visible to anything that can read the process
> list — the same exposure a hand-typed `curl` has. The alternative, a
> temporary file, leaves it on disk instead.

### Saved requests and recent runs

**Saved** keeps a request whole — method, headers, body, auth — under a name,
because a POST with three headers and a JSON body is not something anyone wants
to retype. Click one to run it; right-click to rename it, copy it as a `curl`
command, or delete it.

**Recent** is every run of every tool, newest first, with the options it was run
with — and where it ran, so the same check from the same server is one click.
A saved request keeps its host the same way, by host rather than by session, so
it still means something tomorrow; if that host has no session open the request
runs from this machine and says so rather than dialling a server because a chip
was clicked. Clicking one runs it again — the same ports, the same packet count, the
same request body — so "check that again" costs one click. Runs that failed are
kept too, since those are the ones most worth repeating after a change. The
same tool against the same target replaces its earlier entry rather than
filling the list with one host.

---

## The AI assistant

The ✦ button in the toolbar, the **AI assistant** row under Local, the start
screen and the + menu open an assistant in a panel on the right that stays put
as tabs change: Claude Code, Codex, GitHub Copilot CLI, OpenCode, Pi or Gemini
CLI, or a command-line tool of your own. Each is the vendor's own tool, signed
in its own way, started with ServerLife's [MCP tools](MCP.md) so it can list
hosts, open sessions, run your macros, read what a terminal shows and — when
you allow it each time — type into one.

- **A check first.** What is missing — the tool, a sign-in, automation being
  off — is said, with a button that fixes each. *How each tool runs* sets it
  to run directly or through a launcher command you type, its model, and extra
  arguments, with the command shown as you edit.
- **Its own folder.** Assistants start in `~/ServerLife AI` (Settings → *AI
  assistant* → *Folder assistants start in*). A tool that asks whether to trust
  its folder asks once there and remembers; it would ask every time in your
  home folder. The folder gets an `AGENTS.md` saying what ServerLife's tools
  are, written only if there is none.
- **Several at once.** *Another Claude Code* opens a second session in its own
  tab — "Claude Code 2". Double-click a tab to rename it; a name given when it
  opens is passed to tools that take one (Claude Code, Copilot, Pi).
- **A question waiting** turns the tab, the ✦ button and the AI row yellow, so
  one asking permission behind another tab is not left waiting. **⏎ Enter**
  in the panel's header answers a prompt without clicking into it.
- **Start with a question.** Double-click the AI row: choose the assistant,
  *Start with* a new conversation, the last one, or one from the tool's own
  list, give it a name, and type what to ask — sent once it is ready.
- **Pick up a past conversation** from the + menu: the last one, or *choose…*
  where the tool has a list (Claude Code, Codex, Copilot, Pi).
- **Ask the AI about this.** Right-click selected output — or a pane with
  nothing selected, for what is on screen — or a host in the list. It is put
  into the assistant's input, with where it came from, for you to add the
  question before it goes.
- **Prompts** in the panel's header: questions you ask often, sent to the
  assistant on show. Three are there to start from; add, change or remove
  them.
- **Save** keeps an answer: the selection, the screen, or the whole
  conversation, named, as Markdown in `~/ServerLife AI/saved`. *Saved
  responses…* reads them back, copies one, shows it in Finder, deletes it, or
  gives it to the assistant again.

## Search everything

The box at the top right of the window (`⌘P`; `Ctrl+Alt+P` on Windows and
Linux) finds anything in ServerLife by name: hosts — by name, address, label
or uuid — saved profiles, clusters, beams, open tabs, macros, snippets,
layouts, past multi-exec runs, saved AI prompts and responses, and every menu
action. Results are grouped by kind, best match first; `Enter` opens the
first, the arrows move, `Escape` goes back to the session. The last entry,
*Search settings for …*, opens Settings at the matching setting.

An agent gets the same search as the `serverlife_search` MCP tool, read-only,
each kind saying which tool takes it from there.

## Interface

- **Settings** is in sections — Teleport homes and tsh, Appearance, Text and
  fonts, File browser, KubeLife, Sessions and the interface and more — with a
  dropdown at the top to show just one, and a **search** that keeps only the
  settings whose words match (each with its explanation). Choosing a setting
  from the title bar's search opens Settings filtered to it.
- **A guided tour** (*Help → Take the Tour…*, offered once on a first run, and
  again when it gains steps). Twenty steps that spotlight the real interface —
  the search box, the host list, the filter, quick connect, splits, the file
  browser, multi-exec, the AI assistant, the dock, Teleport, keys and network
  tools — and say what each is for and how to use it. The app
  underneath stays live and usable, so nothing has to be undone afterwards, and
  Escape or *Skip tour* leaves at any point.
- **This guide** (*Help → Guide*, `⌘/`) with a section list, a search box that
  marks every hit and steps between them, and buttons to copy or save the whole
  thing. It is the same text as GUIDE.md in the repository, bundled into the
  app so it works from a packaged build.
- **Resizable dialogs.** Network and certificate tools and this guide have a drag handle in the
  corner and remember the size you left them at — the useful shape depends on
  what is being read, not on what the dialog is.
- **Saved profiles** with folders, a startup command, and remote/local start
  directories.
- **Splitting with nothing focused** asks you to click the pane to split, then
  splits there; with nothing open at all it just opens a local shell.
- **Closing a tab** plays the pane close animation on every pane it held, all
  at once (*Settings → Pane close animations* turns them off).
- **Focus follows the mouse** (*Settings*, off by default) now covers the AI
  panel as well as the panes: hover it and it takes the keyboard.
- **Themes**: light, dark, or automatic (follows the OS), thirty-eight named
  themes, and seven accent colours. Terminals recolour with the UI. **Matrix**
  is phosphor green on green-black but keeps red, yellow and blue distinct in
  the terminal; the **Matrix skin** (*Settings → Skin*) is the all-green one.
  The **Thug Life** skin is black and gold, with blackletter on the sidebar's
  headings and host names and on dialog titles; the terminal keeps its font.
- **Fonts**: *Settings → Font family* and *Pane style → Font* list what is
  installed, then **fifty-one bundled with ServerLife** — forty-two fixed-width
  (JetBrains Mono, Fira Code, IBM Plex Mono, Victor Mono, Geist Mono, Press
  Start 2P…) and nine display faces (UnifrakturMaguntia, Pirata One, Creepster,
  Monoton…), labelled as not fixed-width since a terminal's columns will not
  line up in them. Each is under its own open licence, listed in
  `src/renderer/fonts/README.md`.
- **A look per pane.** Right-click a pane → *Pane style*: a dark or light
  theme, a terminal palette, a font — for that pane only, its file browser and
  header included. The first change asks whether to use it for that host from
  now on; the host's menu (or *Local shell*'s) then has *Saved pane style* to
  change or clear it.
- **Terminal palettes**, separately from the theme: Solarized dark and light,
  Gruvbox, Nord, Dracula and a high-contrast set. Someone who asked for
  Solarized asked for Solarized whatever colour the sidebar is, so a named
  palette wins over both the theme and any skin.
- **Titles say who and where.** A pane and its tab read `ubuntu@tele1c: ~` or
  `local: /var/log`, and follow the shell as it moves — a row of tabs all saying
  "Local shell" tells you nothing. The directory is read from the shell's own
  *process* rather than by typing `pwd` into your terminal, and only for the tab
  you are looking at. A pane over `tsh` or a beam keeps the directory it started
  in, since a probe there would cost another MFA prompt. Naming the shell as
  well (`zsh: ~`) is a preference, off by default.
- **The window and the panels remember their size**: where the window was, how
  big, whether it was maximised, and the widths of the sidebar, the file panel,
  the dock and the terminal split. The window is checked against the displays
  that exist at launch, so one last used on a monitor you have since unplugged
  is clamped to fit rather than opening somewhere unreachable.
- **Reopening a session** offers your last layout with each tab's panes named as
  `ubuntu@ent: ~/deploy` — who, where, and in which directory. Clicking one row
  reopens just that session and closes the offer; the rest stay saved for next
  launch. A local shell comes back in the directory it was in, and a remote one
  is sent a `cd` once its shell is up.
- **Hide hosts** you never use; show them again from any host's menu.
- Searchable host filter across names, clusters, addresses and
  [tags](#teleport), with a count of how many hosts matched. The buttons under
  it — *Tags…*, *Show tags*, *Heartbeats*, *Folders* — act on host rows, so they
  appear on the Hosts tab only; the filter box itself works on every tab.
- Terminal search (`⌘F`), zoom, and configurable font and scrollback.
- **Live stats under each server session** — tmux panes included: CPU with a
  sparkline, memory, swap, load, disk, network and uptime, amber or red when
  high. They come from **one** long-running command per host, shared by every
  pane on it and stopped when the last one closes — on a Teleport node that is
  one audit-log entry, not one every few seconds. Linux only (it reads
  `/proc`); off on per-session-MFA hosts, which would ask for another
  approval. *Settings → Live stats under each server session*, or *Hide live
  stats* on a pane's menu for that host.
- **Live stats under a local shell**, on macOS and Linux: the same bar for this
  computer, read by the app itself (no command runs), under plain shells —
  not under a login, a Phase build or an assistant the app started in a tab.
  *Hide live stats* on a local pane's menu turns it off for every local shell,
  and it stays off; *Show live stats*, or *Settings → …and under local shells*,
  brings it back.
- **One live stats bar per machine in a tab** (*Settings*, off by default):
  split panes on the same host — or several local shells — in one tab share a
  single bar, on the first of them, and the others keep that row for the
  terminal. Close that pane and the next one takes the bar.
- **Redraw** on a pane's menu fixes muddled text — what hiding and showing the
  file browser used to do. It repaints the terminal and resizes the session by
  a column and back, so a program that draws its own screen (Claude Code's
  input box, vim, htop) draws it again; it happens most in a narrow pane where
  long lines wrap. Terminals also repaint after the computer wakes or unlocks.
- **No background commands on servers** (*Settings*) stops everything the app
  runs on a host by itself: live stats, following the shell's folder, the file
  browser's free space and its re-listing every few seconds. With it on, a
  Teleport audit log holds only what you did; refresh still works when asked.
- **The dock** along the bottom collects the things that outlive a single
  action: transfers, port forwards, multi-exec runs, the connection log, the
  [download history](#file-browser-and-transfers) and the
  [folders being watched](#file-browser-and-transfers). **Transfers** is one
  fixed, small height — about three rows, the rest scrolling — so the terminal
  above it does not move as a sync queues and finishes its files.
- **An external editor** can be named in Settings for *Edit in my editor…*;
  left empty, each file opens in whatever this machine already uses for it.

---

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘P` | Search everything (`Ctrl+Alt+P` on Windows and Linux) |
| `⌘N` | New session |
| `⌘⌥C` | Quick connect to a typed address |
| `⌘T` | New local shell |
| `⌘D` | Duplicate tab |
| `⌘⇧D` / `⌘⇧E` | Split right / split down |
| `⌘W` | Close pane |
| `⌘1`–`⌘9` | Jump to tab |
| `⌘⌥←` / `⌘⌥→` | Previous / next tab |
| `⌘⌥D` / `⌘⌥E` | Split with **another** host, right / down |
| `⌘⇧M` | Multi-exec |
| `⌘⇧C` | Command snippets |
| `⌘⇧K` | SSH keys |
| `⌘⇧T` | Network and certificate tools |
| `⌘⇧R` | Run a macro on the focused host |
| `⌘⌥N` | New window |
| `⌘⇧L` | Toggle session log |
| `⌘⇧F` | Show/hide local files in this pane |
| `⌘⇧P` | Explorer beside / above the terminal |
| `⌘⇧S` / `⌘⇧O` | Save layout as / load layout |
| `⌘⇧N` | Add a server |
| `⌘F` | Search this pane's scrollback |
| `⌘⇧B` | Toggle broadcast typing |
| `⌘B` | Show/hide the hosts list |
| `⌘E` | Show/hide every file explorer |
| `⌘J` | Show/hide transfers |
| `⌘F` | Find in terminal |
| `⌘K` | Clear terminal |
| `⌕` / typing | Filter the focused file list by name; `↑` `↓` walk the matches |
| `⌘R` | Refresh inventory |
| `⌘Y` / `⌘⇧Y` | Session history / recorded sessions |
| `⌘+` / `⌘-` / `⌘0` | Zoom in / out / reset |

---

---

## How it works

```
                    ┌──────────── one authentication ────────────┐
                    │                                            │
  ServerLife ──► ssh ControlMaster ──► (tsh proxy ssh) ──► server
                    │
                    ├── ssh -tt            → terminal tab
                    ├── ssh -tt            → split pane
                    ├── ssh -s sftp        → file browser (SFTP v3)
                    ├── ssh -O forward     → port forwards
                    └── ssh -T <command>   → multi-exec, server probe
```

For Teleport hosts, ServerLife generates an `ssh_config` with `tsh config` whose
`ProxyCommand` routes through `tsh proxy ssh`. From that point on both host
types are identical to every layer above.

---

---

## Troubleshooting

**macOS: "Apple could not verify 'ServerLife' is free of malware"**
Expected — the build is ad-hoc signed rather than notarised. If you pressed
*Move to Trash*, restore it from the Trash (or download it again) and follow
[macOS install](#macos): clear the quarantine flag before the first launch, or
allow it once under System Settings → Privacy & Security → *Open Anyway*.
Control-click → *Open* stopped working for unnotarised apps in macOS 15.

**Windows: "Windows protected your PC"**
SmartScreen, for the same reason. *More info* → *Run anyway*.

**Sidebar shows "tsh: not logged in"**
Run `tsh login --proxy=your.proxy.com`, then press `⌘R`. Expired profiles get a
*tsh login* button in place of their node list.

**A host connects in a terminal but the file browser says "not connected"**
The node may not offer the SFTP subsystem. Check the *Connection log* tab in the
bottom dock for what the server actually said.

**Connection times out with no prompt**
Open the *Connection log* tab. If authentication is waiting on input, the
connecting pane shows a text box — MFA taps and passwords are answered there.

**X11: `cannot open display`**
Start XQuartz, then launch ServerLife **from a terminal** so it inherits
`DISPLAY`. Settings shows what was detected.

**Native module errors after upgrading Node or Electron**
```sh
make rebuild
```

---
