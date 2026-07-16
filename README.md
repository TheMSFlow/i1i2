# i1i2

Randomly pairs football players into squads for pickup games (4v4, 5v5, 7v7, 11v11), manages a winner-stays queue, and runs a round timer with a synthesized whistle. Plain HTML/CSS/JS, no build step.

## How it works
1. Pick a format and enter how many players are on the pitch.
2. Players number themselves 1 to N beforehand.
3. The app shuffles numbers into squads. Leftovers form a smaller squad marked Incomplete.
4. Squad 1 and Squad 2 start on the pitch, the rest queue up.
5. Referee sets a round timer and starts it.
6. A goal keeps the scoring squad on, swaps in the next squad from the queue.
7. When the timer runs out, both squads on the pitch are swapped out (whistle sounds), and the next two queued squads come on.

State is saved to localStorage, so a page refresh won't lose the game in progress.

## Local dev
Open `index.html` directly in a browser, or serve it:

```
npx serve .
```

## Deploy
Push to GitHub, then import the repo on vercel.com. No build settings needed, it's a static site.
