# Physio Quest LIVE

A live multiplayer physiotherapy quiz built for groups. The host runs the game from one screen, and up to 100 players can join on their phones. The 30-question beginner bank introduces physical therapy, everyday movement, goal-setting, and simple ways to track progress.

## Run the game

Use Node.js 18 or later:

```bash
npm ci
npm start
```

Open `http://localhost:3000`. Choose **Host game** and pick 10, 20, or 30 questions. Every game ends with the Final Boss. For phones on the same local network, open the host computer’s reachable LAN address with port 3000. For remote players, use the same public URL on a Node.js host that supports Socket.IO. The server honors the `PORT` environment variable.

## Play a round

1. The host shares the six-digit PIN or invite link.
2. Each player enters a nickname and taps **I’m ready**. Once all connected players are ready, the host can start.
3. Everyone can answer. Unless a round says otherwise, correct answers score in order of receipt: 1,000, 900, 800, and so on down to 100 from tenth place onward. Incorrect answers do not take a rank.
4. The correct answer, explanation, and each player's point breakdown appear when time runs out or all connected players lock an answer. The host advances when the group is ready.

| Round | Rule |
| --- | --- |
| Movement Lab | Explore comparison charts or scrub through movement frames before answering. |
| Double Down | Optional +400 for a correct answer or −200 for a wrong answer. |
| Clue Drop | A clue appears halfway through. Correct answers before it drops earn +200. |
| Second Look | Keep the first choice or change it once. The first choice keeps its timestamp if you lock it or let the timer expire. A change takes the timestamp of the new choice and locks it. |
| Think Tank | Every correct answer earns 700 base points regardless of speed. |
| Beat the Fuse | Correct answers in the first 70% of the timer earn +300. |
| Final Boss | Correct answers earn double the ranked base points. |

A streak adds 200 points to each correct answer from the third in a row. Incorrect or missed answers reset the streak. Tap **Music off** for the looping background track and **Sound off** for round and countdown cues. The two controls work independently on each device.

Players and the host can reload the same tab to reconnect. New seats can join before the first question. Rooms live in memory on a single server instance and expire after three hours or when the server restarts. Edit `questions.json` to customize the bank.

## Deploy on Render

Connect this repository in Render using **New → Blueprint**. Render reads
`render.yaml` and creates a single Node web service. Once the deploy is live,
open its HTTPS URL, create a room, and share that URL and PIN with players.

The free service can sleep when idle. Open the app before inviting players so
it has time to start. A restart clears active rooms and scores.
