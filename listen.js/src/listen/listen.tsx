// Copyright 2023-2024 Daniel C. Brotsky. All rights reserved.
// Licensed under the GNU Affero General Public License v3.
// See the LICENSE file for details.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Cookies from 'js-cookie'
import { AblyProvider, ChannelResult, useChannel, usePresence } from 'ably/react'
import * as Ably from 'ably'

import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'

import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import {
    controlOffsetValue,
    parseContentChunk,
    parseControlChunk,
    parsePresenceChunk,
}
    from '../protocol.js'

const conversationId = Cookies.get('conversationId') || ''
const conversationName = Cookies.get('conversationName') || ''
const whispererName = Cookies.get('whispererName') || ''
const clientId = Cookies.get('clientId') || ''
let clientName = Cookies.get('clientName') || ''
const logPresenceChunks = Cookies.get('logPresenceChunks') || ''
let playTyping = Cookies.get('playTyping') || 'YES'
let transcriptLink: string = ''

if (!conversationId || !whispererName || !clientId || !conversationName) {
    window.location.href = '/subscribe404.html'
}

const player = new Audio()
const typer = new Audio()

const client = new Ably.Realtime.Promise({
    clientId: clientId,
    authUrl: '/api/v2/listenTokenRequest',
    echoMessages: false,
    autoConnect: false, // don't connect until we have a client name in cookie for use in auth
    // log: { level: 4 },
})

interface Text {
    live: string,
    past: string,
}

interface Link {
    host: string,
    url: string,
}

export default function ListenerView() {
    const [exitMsg, setExitMsg] = useState('')
    const [listenerName, setListenerName] = useState('')
    if (!listenerName) {
        return <NameView confirm={(msg) => setListenerName(msg)} />
    } else if (exitMsg) {
        return <DisconnectedView message={exitMsg} />
    } else {
        return (
            <AblyProvider client={client}>
                <ConnectView exit={(msg) => setExitMsg(msg)} />
            </AblyProvider>
        )
    }
}

function NameView(props: { confirm: (msg: string) => void }) {
    const [name, setName] = useState(clientName)

    function onChange(e: React.ChangeEvent<HTMLInputElement>) {
        setName(e.target.value)
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'Enter') {
            e.preventDefault()
            onConfirm()
        }
    }

    function onConfirm() {
        clientName = name
        Cookies.set('clientName', clientName, { expires: 365 })
        client.connect()
        props.confirm(name)
    }

    return (
        <Stack spacing={5}>
            <Typography variant="h4" gutterBottom>
                Advisory
            </Typography>
            <Typography maxWidth={'60ch'}>
                By entering your name below, you are agreeing to engage
                in a conversation called “{conversationName}”
                with the user “{whispererName}”.
                The name you enter here will be
                revealed to that person, and what they type will
                appear for you to see. If you don't wish
                to participate in this conversation, just close this window.
            </Typography>
            <Typography variant="h5" gutterBottom>
                Please provide your name to {whispererName}:
            </Typography>
            <Grid container component="form" noValidate autoComplete="off">
                <Grid item>
                    <TextField
                        id="outlined-basic"
                        label="Listener Name"
                        variant="outlined"
                        style={{ width: '40ch' }}
                        value={name}
                        onChange={onChange}
                        onKeyDown={onKeyDown}
                    />
                </Grid>
                <Grid item alignItems="stretch" style={{ display: 'flex' }}>
                    <Button variant="contained" onClick={onConfirm} disabled={name.length == 0}>
                        Agree & Provide Name
                    </Button>
                </Grid>
            </Grid>
        </Stack>
    )
}

function DisconnectedView(props: { message: string }) {
    stopTyping()
    console.log('Waiting a second to drain messages, then closing client')
    setTimeout(() => client.close(), 1000)
    return (
        <Stack spacing={5}>
            <Typography variant="h4">Disconnected from conversation “{conversationName}”</Typography>
            {props.message != 'user-initiated-disconnect' && <Typography>{props.message}</Typography>}
            <Typography>
                You can close this window or <a href={window.location.href}>click here to listen again</a>.
            </Typography>
            {transcriptLink &&
                <Typography>A transcript of the conversation is available <a
                    href={transcriptLink} target={'_blank'}>at this link</a>.</Typography>}
        </Stack>
    )
}

function ConnectView(props: { exit: (msg: string) => void }) {
    const [status, setStatus] = useState('waiting')
    const [typing, setTyping] = useState(playTyping === 'YES')
    const [transcript, setTranscript] = useState(false)
    // @ts-ignore
    const { channel }: ChannelResult = useChannel(
        `${conversationId}:control`,
        m => receiveControlChunk(m, channel, setStatus, setTranscript, props.exit))
    const { updateStatus } = usePresence(`${conversationId}:control`, 'connect')
    hookUnload(() => {
        updateStatus('dropping')
    })
    const exit = (msg: string) => {
        sendDrop(channel)
        props.exit(msg)
    }
    const rereadLiveText = () => sendRereadText(channel)
    doCount(() => sendListenOffer(channel), 'initialOffer', 1)
    return (
        <Stack spacing={5}>
            <Typography variant="h4">Conversation “{conversationName}” with {whispererName}</Typography>
            <StatusView status={status} transcript={transcript} typing={typing} setTyping={setTyping} exit={exit} />
            {status.match(/^[A-Za-z0-9-]{36}$/) &&
                <ConversationView contentId={status} reread={rereadLiveText} />
            }
        </Stack>
    )
}

function StatusView(props: {
    status: string,
    transcript: boolean,
    typing: boolean,
    setTyping: React.Dispatch<React.SetStateAction<boolean>>,
    exit: (msg: string) => void
}) {
    let message: string
    let connected: boolean = false
    const disconnect = () => props.exit('user-initiated-disconnect')
    const toggleTyping = () => {
        if (props.typing) {
            props.setTyping(false)
            playTyping = 'NO'
            stopTyping()
        } else {
            props.setTyping(true)
            playTyping = 'YES'
        }
        Cookies.set('playTyping', playTyping)
    }
    switch (props.status) {
        case 'waiting':
            message = `Waiting for ${whispererName} to join...`
            break
        case 'requesting':
            message = `Requesting permission to join the conversation...`
            break
        default:
            if (props.status.match(/^[A-Za-z0-9-]{36}$/)) {
                message = 'Connected and listening...'
                connected = true
            } else {
                message = `Something has gone wrong (invalid status ${props.status}).`
                setTimeout(
                    () => props.exit(`A connection error occurred.  Please try refreshing this window.`),
                    250,
                )
            }
    }
    return (
        <>
            <Grid container component="form" noValidate autoComplete="off">
                <Grid item>
                    <TextField
                        id="outlined-basic"
                        label="Connection Status"
                        variant="outlined"
                        style={{ width: '50ch' }}
                        value={message}
                        disabled
                    />
                </Grid>
                <Grid item alignItems="stretch" style={{ display: 'flex' }}>
                    <Button variant="contained" onClick={disconnect}>
                        Leave Conversation
                    </Button>
                </Grid>
            </Grid>
            {connected &&
                <Grid container component="form" noValidate autoComplete="off">
                    <Grid item alignItems="stretch" style={{ display: 'flex' }}>
                        <Button variant="contained" onClick={toggleTyping}>
                            {props.typing ? 'Don\'t Play Typing Sounds' : 'Play Typing Sounds'}
                        </Button>
                    </Grid>
                    {props.transcript &&
                        <Grid item alignItems="stretch" style={{ display: 'flex' }}>
                            <Button variant="contained" href={transcriptLink} target={'_blank'}>
                                Open Transcript
                            </Button>
                        </Grid>
                    }
                </Grid>
            }
        </>
    )
}

function ConversationView(props: { contentId: string, reread: () => void }) {
    const [text, updateText] = useState({ live: '', past: '' } as Text)
    const [links, setLinks] = React.useState([] as Link[])
    useChannel(
        `${conversationId}:${props.contentId}`,
        (m) => receiveContentChunk(m, updateText, setLinks, props.reread),
    )
    doCount(props.reread, 'initialRead', 1)
    return (
        <>
            <LivePastText text={text} />
            <WhisperedLinks links={links} />
        </>
    )
}

function LivePastText(props: { text: Text }) {
    const preventDefault = (event: React.ClipboardEvent<HTMLInputElement>, message: string) => {
        console.log(message)
        event.preventDefault()
    }
    const disableCopy = (e: React.ClipboardEvent<HTMLInputElement>) => preventDefault(e, 'Copy blocked')
    const disableCut = (e: React.ClipboardEvent<HTMLInputElement>) => preventDefault(e, 'Cut blocked')
    const pastTextBox = useRef(null)
    useLayoutEffect(() => {
        if (pastTextBox.current !== null) {
            const element = pastTextBox.current as unknown as HTMLInputElement
            const textArea = element.children[1].children[0]
            textArea.scrollTop = textArea.scrollHeight
        }
    })
    return (
        <>
            <TextField
                multiline
                ref={pastTextBox}
                label={`Past Typing`}
                id="pastText"
                minRows={5}
                maxRows={12}
                value={props.text.past || ' '}
                onCopy={disableCopy}
                onCut={disableCut}
            />
            <TextField
                multiline
                label={`Live Typing`}
                minRows={2}
                value={props.text.live || ' '}
                onCopy={disableCopy}
                onCut={disableCut}
            />
        </>
    )
}

function WhisperedLinks(props: { links: Link[] }) {
    let items = props.links.map((value, index) =>
        <li key={index}><a href={value.url} target={'_blank'}>{value.host}</a></li>,
    )
    return (
        <>
            {items.length > 0 &&
                <>
                    <Typography>Here are the links typed by the Whisperer, in order:
                        <ol>{items}</ol></Typography>
                </>
            }
        </>
    )
}

function sendControlChunk(channel: Ably.Types.RealtimeChannelPromise, id: string, chunk: string) {
    console.debug(`Sending control chunk: ${chunk}`)
    channel.publish(id, chunk).then()
}

function receiveControlChunk(message: Ably.Types.Message,
                             channel: Ably.Types.RealtimeChannelPromise,
                             setStatus: React.Dispatch<React.SetStateAction<string>>,
                             setTranscript: React.Dispatch<React.SetStateAction<boolean>>,
                             exit: (msg: string) => void) {
    const me = clientId.toUpperCase()
    const topic = message.name.toUpperCase()
    if (topic != me && topic != 'ALL') {
        // ignoring message for another client
        return
    }
    const info = parsePresenceChunk(message.data)
    if (info) {
        logPresenceChunk('received', message.data)
    } else {
        const other = parseControlChunk(message.data)
        if (!other || other.offset != 'transcriptId') {
            console.error(`Received unexpected control packet: ${message.data}`)
            return
        }
        console.log(`Received transcript id ${other.text}`)
        transcriptLink = `/transcript/${conversationId}/${other.text}`
        setTranscript(true)
    }
    switch (info?.offset) {
        case 'dropping':
            console.log(`Whisperer is dropping this client`)
            exit(`${whispererName} has stopped whispering.`)
            break
        case 'restart':
            console.log(`Whisperer is restarting`)
            exit(`${whispererName} has paused the conversation.  Please try listening again.`)
            break
        case 'listenAuthYes':
            console.log(`Received content id: ${info.contentId}`)
            if (info.contentId.match(/^[A-Za-z0-9-]{36}$/)) {
                console.log(`Joining the conversation`)
                const offset = controlOffsetValue('joining')
                const chunk = `${offset}|${conversationId}|${info.conversationName}|${clientId}|${clientId}|${clientName}|`
                sendControlChunk(channel, info.clientId, chunk)
                logPresenceChunk('sent', chunk)
                setStatus(info.contentId)
            } else {
                console.error(`Invalid content id: ${info.contentId}.  Please report a bug!`)
                sendDrop(channel)
                exit(`There was a communication error (invalid channel id).  Please report a bug.`)
            }
            break
        case 'listenAuthNo':
            console.log(`Whisperer refused listener presence`)
            sendDrop(channel)
            exit(`${whispererName} has refused your presence in this conversation`)
            break
        case 'whisperOffer':
            console.log(`Received Whisper offer, sending request`)
            setStatus('requesting')
            console.log(`Received whisper offer from ${info.clientId}, sending listen request`)
            const offset = controlOffsetValue('listenRequest')
            const chunk = `${offset}|${conversationId}|${info.conversationName}|${clientId}|${clientId}|${clientName}|`
            sendControlChunk(channel, info.clientId, chunk)
            logPresenceChunk('sent', chunk)
            break
        default:
            console.log(`Received unexpected control packet, resending listen offer: ${message.data}`)
            sendListenOffer(channel)
    }
}

let resetInProgress = false

function receiveContentChunk(message: Ably.Types.Message,
                             updateText: React.Dispatch<React.SetStateAction<Text>>,
                             updateLinks: React.Dispatch<React.SetStateAction<Link[]>>,
                             reread: () => void) {
    const me = clientId.toUpperCase()
    const topic = message.name.toUpperCase()
    if (topic != me && topic != 'ALL') {
        // ignoring message for another client
        return
    }
    const chunk = parseContentChunk(message.data as string)
    if (!chunk) {
        console.error(`Ignoring invalid content chunk: ${message.data as string}`)
        return
    }
    if (chunk.offset === 'playSound') {
        player.src = `/snd/${chunk.text}.mp3`
        player.play().then()
    } else if (chunk.isDiff) {
        // sometimes we lose the end of resets, so if we get a diff assume it's completed.
        resetInProgress = false
        if (chunk.offset === 0) {
            updateText((text: Text) => {
                if (text.live.length == 0 && chunk.text.length > 0) {
                    // these are the first live characters received
                    maybeStartTyping()
                } else if (text.live.length > 0 && chunk.text.length == 0) {
                    // the live characters have been erased
                    stopTyping()
                }
                return { live: chunk.text, past: text.past }
            })
        } else if (chunk.offset === 'newline') {
            maybeEndTyping()
            console.log('Appending live text to past text')
            let links: Link[] = []
            updateText((text: Text) => {
                links = getLinks(text.live)
                return { live: '', past: text.past + '\n' + text.live }
            })
            updateLinks(old => old.concat(links))
        } else {
            const offset = chunk.offset as number
            updateText((text: Text): Text => {
                if (offset > text.live.length) {
                    console.log(`Received offset ${offset} with text length ${text.live.length}, rereading...`)
                    reread()
                    return text
                } else {
                    return { live: text.live.substring(0, offset) + chunk.text, past: text.past }
                }
            })
        }
    } else if (resetInProgress) {
        if (chunk.offset === 'startReread') {
            console.log('Received reset acknowledgement from whisperer, resetting live text')
            updateText((text: Text) => {
                return { live: '', past: text.past }
            })
        } else if (chunk.isDiff) {
            console.log('Ignoring diff chunk because a read is in progress')
        } else if (chunk.offset === 'pastText') {
            console.log('Received unexpected past line chunk, ignoring it')
        } else if (chunk.offset === 'liveText') {
            console.log('Receive live text chunk, update is over')
            resetInProgress = false
            if (chunk.text.length > 0) {
                maybeStartTyping()
            }
            updateText((text: Text) => {
                return { live: chunk.text, past: text.past }
            })
        } else {
            console.log(`Ignoring unexpected chunk during reset: ${chunk}`)
        }
    } else {
        if (typeof chunk.offset === 'string') {
            console.warn(`Ignoring ${chunk.offset} content request for: ${chunk.text}`)
        } else {
            console.error(`Unimplemented content chunk with offset ${chunk.offset} text: ${chunk.text}`)
        }
    }
}

function sendDrop(channel: Ably.Types.RealtimeChannelPromise) {
    console.log(`Sending drop message`)
    let chunk = `${controlOffsetValue('dropping')}|||${clientId}|||`
    channel.publish('whisperer', chunk).then()
}

function sendListenOffer(channel: Ably.Types.RealtimeChannelPromise) {
    console.log(`Sending listen offer`)
    // turns out we can send before we're fully connected.  But if we do that, we don't
    // hear the reply from the listener.  So make sure we're connected before we send.
    function sendPacket() {
        let chunk = `${controlOffsetValue('listenOffer')}|${conversationId}||${clientId}|${clientId}||`
        sendControlChunk(channel, 'whisperer', chunk)
        logPresenceChunk('sent', chunk)
    }

    channel.attach().then(sendPacket)
}

function sendRereadText(channel: Ably.Types.RealtimeChannelPromise) {
    if (resetInProgress) {
        // already re-reading all the text
        return
    }
    console.log('Requesting resend of live text...')
    resetInProgress = true
    // request the whisperer to send all the text
    let chunk = `${controlOffsetValue('requestReread')}|live`
    sendControlChunk(channel, 'whisperer', chunk)
}

function maybeStartTyping() {
    if (playTyping == 'YES') {
        typer.pause()
        typer.src = `/snd/typewriter-two-minutes.mp3`
        typer.play().then()
    }
}

function maybeEndTyping() {
    typer.pause()
    if (playTyping == 'YES') {
        typer.src = `/snd/typewriter-carriage-return.mp3`
        typer.play().then()
    }
}

function stopTyping() {
    typer.pause()
}

function getLinks(text: string) {
    const re1 = /\b([a-z][\w-]+:)?(\/\/+)?([a-z0-9-]+(\.[a-z0-9-]+)+)(\/+\S*)?/gi
    const re2 = /^[a-z][\w-]+:/
    const result = text.match(re1)
    const urls: Link[] = []
    if (result != null) {
        for (let match of result) {
            if (match.endsWith('.')) {
                // remove trailing period - it's probably a sentence terminator
                match = match.substring(0, match.length - 1)
            }
            let fullUrl = match.match(re2) != null ? match : `https:${match}`
            try {
                let url = new URL(fullUrl)
                let host = url.host
                urls.push({ host, url: url.href })
            } catch (e) {
                console.warn(`Ignoring matched non-url: ${match}`)
            }
        }
    }
    return urls
}

function logPresenceChunk(sentOrReceived: string, chunk: string) {
    if (!logPresenceChunks) {
        return
    }
    const url = window.location.origin + '/api/v2/logPresenceChunk'
    fetch(url, {
        method: 'POST',
        mode: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientId: clientId,
            sentOrReceived: sentOrReceived,
            kind: 'TCP',
            chunk: chunk,
        }),
    }).then(() => console.log(`Logged ${sentOrReceived} chunk: ${chunk}`))
}

function hookUnload(fn: () => void) {
    useEffect(() => {
        const handleClose = () => {
            console.log('Running beforeunload hook...')
            fn()
        }
        window.addEventListener('beforeunload', handleClose)
        return () => {
            window.removeEventListener('beforeunload', handleClose)
        }
    }, [])
}

const doneCounts: { [p: string]: number } = {}

function doCount(fn: (() => void), which: string, max: number) {
    const doneCount = doneCounts[which] || 0
    if (doneCount < max) {
        doneCounts[which] = doneCount + 1
        fn()
    }
}
