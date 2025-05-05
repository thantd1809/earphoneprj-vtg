import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  createAttendee,
  createAppInstanceUsers,
  addChannelMembership,
  listAttendee,
  translateTextSpeech,
  getMeetingByTourId,
  getMeeting,
} from '../apis/api';
import {
  DefaultDeviceController,
  DefaultMeetingSession,
  ConsoleLogger,
  LogLevel,
  MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';
import '../styles/LiveViewer.css';
import Config from '../utils/config';
import metricReport from '../utils/MetricReport';
import JSONCookieUtils from '../utils/JSONCookieUtils';
import { checkAvailableMeeting } from '../utils/MeetingUtils';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import { LISTEN_VOICE_LANGUAGES, JA_LISTEN_VOICE_LANGUAGES } from '../utils/constant';
import Header from './Header';
import { HiMiniSpeakerWave } from "react-icons/hi2";
import { IoVolumeMute } from "react-icons/io5";
// import { IoMicCircle, IoMicOffCircleSharp } from "react-icons/io5";
import MessageBox from './MessageBox';
import { useParams } from "react-router-dom";
import NotFound from './NotFound';
import TourTitle from './TourTitle';
import { FaPause, FaPlay } from "react-icons/fa";

function LiveViewer2() {
  // Get the params from the URL
  const { tourId } = useParams(); // Extracts 'tourId' from the URL
  console.log('tourId:', tourId);
  const { t, i18n } = useTranslation();
  const [tour, setTour] = useState(undefined);
  const [meetingSession, setMeetingSession] = useState(null);
  const [meeting, setMeeting] = useState(null);
  const [attendee, setAttendee] = useState(null);
  const [channelArn, setChannelArn] = useState('');
  const [userArn, setUserArn] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [participantsCount, setParticipantsCount] = useState(0);
  const [transcripts, setTranscriptions] = useState([]);
  const [transcriptText, setTranscriptText] = useState([]);
  const [translatedText, setTranslatedText] = useState([]);
  const [sourceLanguageCode, setSourceLanguageCode] = useState(null);
  const [selectedVoiceLanguage, setSelectedVoiceLanguage] = useState(
    LISTEN_VOICE_LANGUAGES.find((lang) => lang.key.startsWith(i18n.language))?.key || 'ja-JP'
  );
  const [chatRestriction, setChatRestriction] = useState(null);
  // Replace local variables with refs
  const transcriptListRef = useRef([]);
  const transcriptList2Ref = useRef([]);
  const translatedListRef = useRef([]);
  const audioQueueRef = useRef([]);
  const audioQueue2Ref = useRef([]);
  const userID = uuidv4();
  const userType = 'User';
  // Ref for the audio element  
  const audioElementRef = useRef(null);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlay, setIsPlay] = useState(false);

  // Add these references and callback:
  const wakeLockRef = useRef(null);
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        console.log('Requesting Wake Lock...');
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          console.log('Wake Lock was released.');
        });
      }
    } catch (error) {
      console.error('Failed to request Wake Lock:', error);
    }
  }, []);

  const initializeMeetingSession = useCallback(async (meetingData, attendeeData) => {
    if (!meetingData || !attendeeData) {
      console.error('Invalid meeting or attendee information');
      return;
    }

    const logger = new ConsoleLogger('ChimeMeetingLogs', LogLevel.INFO);
    const deviceController = new DefaultDeviceController(logger);
    const meetingSessionConfig = new MeetingSessionConfiguration(meetingData, attendeeData);
    const session = new DefaultMeetingSession(meetingSessionConfig, logger, deviceController);
    setMeetingSession(session);

    await selectSpeaker(session);
    if (selectedVoiceLanguage === 'ja-JP') {
      console.log('Selected voice language is Japanese', selectedVoiceLanguage);
      //const audioElement = document.getElementById('audioElementListener');
      const audioElement = audioElementRef.current;
      console.log('Check audioElement:', audioElement);
      if (audioElement) {
        await session.audioVideo.bindAudioElement(audioElement);
      } else {
        console.error('Audio element not found');
      }
    }
    metricReport(session);
    session.audioVideo.start();
  }, [selectedVoiceLanguage]);

  const selectSpeaker = async (session) => {
    try {
      const audioOutputDevices = await session.audioVideo.listAudioOutputDevices();
      if (audioOutputDevices.length > 0) {
        await session.audioVideo.chooseAudioOutput(audioOutputDevices[0].deviceId);
      } else {
        console.log('No speaker devices found');
      }
    } catch (error) {
      console.error('Error selecting speaker:', error);
    }
  };

  const createAppUserAndJoinChannel = useCallback(
    async (meetingId, attendeeId, userID, userType, channelId) => {
      try {
        const channelArn = `${Config.appInstanceArn}/channel/${channelId}`;
        const listAttendeeResponse = await listAttendee(meetingId);
        const attendees = listAttendeeResponse.attendees || [];
        const subGuideList = attendees.filter(
          (member) => member.ExternalUserId && member.ExternalUserId.startsWith(userType)
        );

        subGuideList.sort(
          (a, b) =>
            parseInt(a.ExternalUserId.split('|')[1]) - parseInt(b.ExternalUserId.split('|')[1])
        );

        const index = subGuideList.findIndex((att) => att.AttendeeId === attendeeId);
        const userName = `${userType}${index + 1}`;

        const newUserArn = await createAppInstanceUsers(userID, userName);
        await addChannelMembership(channelArn, newUserArn);

        return { channelArn, userArn: newUserArn };
      } catch (error) {
        console.error('Error creating user and joining channel:', error);
        throw error;
      }
    },
    []
  );

  const getMeetingAttendeeInfoFromCookies = useCallback(
    (retrievedUser) => {
      setIsLoading(true);
      initializeMeetingSession(retrievedUser.meeting, retrievedUser.attendee);
      setMeeting(retrievedUser.meeting);
      setAttendee(retrievedUser.attendee);
      setUserArn(retrievedUser.userArn);
      setChannelArn(retrievedUser.channelArn);
      setIsLoading(false);
    },
    [initializeMeetingSession]
  );

  const joinMeeting = useCallback(
    async (meetingData, channelId) => {
      setIsLoading(true);
      try {
        // if (!meetingId || !channelId || !hostId) {
        //   alert('Meeting ID, Channel ID, and Host ID are required');
        //   return;
        // }

        console.log('meeting:', meetingData);
        console.log('channelId:', channelId);

        // const meetingData = await checkAvailableMeeting(meetingId, userType);
        // console.log('meetingData:', meetingData);
        // if (!meetingData) return;

        const attendeeData = await createAttendee(
          meetingData.MeetingId,
          `${userType}|${Date.now()}`
        );
        await initializeMeetingSession(meetingData, attendeeData);

        const { channelArn, userArn } = await createAppUserAndJoinChannel(
          meetingData.MeetingId,
          attendeeData.AttendeeId,
          userID,
          userType,
          channelId
        );

        setMeeting(meetingData);
        setAttendee(attendeeData);
        setChannelArn(channelArn);
        setUserArn(userArn);
        console.log('Cookie set for 1 day!');
        //setIsJoinAudio(true);
        const user = {
          meeting: meetingData,
          attendee: attendeeData,
          userArn,
          channelArn,
        };

        JSONCookieUtils.setJSONCookie('User' + tourId, user, 1);

      } catch (error) {
        console.error('Error joining the meeting:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [
      userID,
      initializeMeetingSession,
      createAppUserAndJoinChannel,
      tourId
    ]
  );

  const joinAudioSession2 = useCallback(
    async (meeting, channelId) => {
      try {
        const retrievedUser = JSONCookieUtils.getJSONCookie('User' + tourId);
        console.log('Check retrievedUser:', retrievedUser);
        console.log('Check retrievedUser meeting:', retrievedUser?.meeting);
        console.log('Check retrievedUser channel:', retrievedUser?.channelArn);
        console.log('Check Input channelId:', channelId);
        console.log('Check Input meeting:', meeting.MeetingId);
        console.log('Check retrievedUser meetingId:', retrievedUser?.meeting.MeetingId);
        console.log('Check retrievedUser channelId:', retrievedUser?.channelArn.split('/').pop());
        console.log('Check retrievedUser channelId:', `${Config.appInstanceArn}/channel/${channelId}`);
        if (retrievedUser) {
          const isMeetingMatched =
            retrievedUser.meeting.MeetingId === meeting.MeetingId;
          const isChannelMatched =
            retrievedUser.channelArn === `${Config.appInstanceArn}/channel/${channelId}`;

          if (isMeetingMatched && isChannelMatched) {
            const meetingData = await checkAvailableMeeting(
              retrievedUser.meeting.MeetingId,
              'User'
            );
            if (meetingData) {
              getMeetingAttendeeInfoFromCookies(retrievedUser);
              return;
            }
          }
        }
        joinMeeting(meeting, channelId);
      } catch (error) {
        console.error('Error processing the User cookie:', error);
      }
    },
    [
      getMeetingAttendeeInfoFromCookies,
      joinMeeting,
      tourId
    ]
  );

  useEffect(() => {
    if (!meetingSession) return;

    const attendeeSet = new Set();
    const presenceCallback = (attendeeId, present) => {
      if (present) {
        attendeeSet.add(attendeeId);
      } else {
        attendeeSet.delete(attendeeId);
      }
      setParticipantsCount(attendeeSet.size);
    };

    // Subscribe to attendee presence
    meetingSession.audioVideo.realtimeSubscribeToAttendeeIdPresence(presenceCallback);

    // Subscribe to transcription events
    meetingSession.audioVideo.transcriptionController?.subscribeToTranscriptEvent(
      (transcriptEvent) => {
        console.log('Check transcriptEvent:', transcriptEvent);
        if (transcriptEvent?.type === 'started') {
          const transcriptionConfig = JSON.parse(transcriptEvent.transcriptionConfiguration);
          setSourceLanguageCode(transcriptionConfig.EngineTranscribeSettings.LanguageCode);
        }
        setTranscriptions(transcriptEvent);
      }
    );
    // splitUrl()
    // Cleanup on unmount
    // return () => {
    //   meetingSession.audioVideo.realtimeUnsubscribeFromAttendeeIdPresence(presenceCallback);
    // };
  }, [meetingSession]);

  const callTranslateTextSpeech = async () => {
    const audioElement = audioElementRef.current;
    if (!audioElement || !meetingSession || !sourceLanguageCode || !selectedVoiceLanguage) return;
    setTranscriptText([]);
    setTranslatedText([]);

    if (
      sourceLanguageCode !== selectedVoiceLanguage &&
      transcripts?.results?.[0]?.alternatives?.[0]?.transcript &&
      !transcripts.results[0].isPartial 
    ) {
      // Process audio queue
      const processAudioQueue = async () => {
        if (audioQueueRef.current.length === 0) return;

        const nextAudio = audioQueueRef.current.shift();
        console.log("nextAudio", nextAudio);
        try {
          await translateAndPlay(nextAudio);
        } catch (error) {
          console.error('Error processing audio queue:', error);
        }

        //setImmediate(processAudioQueue);
        setTimeout(processAudioQueue, 0);
      };

      // Translate and play the audio
      const translateAndPlay = async (currentText) => {
        try {
          let targetLanguageCode = selectedVoiceLanguage;
          if (selectedVoiceLanguage === 'cmn-CN') {
            targetLanguageCode = "zh";
          }

          console.log('Check sourceLanguageCode:', sourceLanguageCode);
          console.log('Check targetLanguageCode:', targetLanguageCode);
          const response = await translateTextSpeech(
            currentText,
            sourceLanguageCode,
            targetLanguageCode,
            "standard"
          );

          console.log('Translated response:', response);
          translatedListRef.current.push(response.translatedText);

          if (!response.speech.AudioStream?.data)
            throw new Error('Invalid AudioStream data');

          const audioBlob = new Blob(
            [Uint8Array.from(response.speech.AudioStream.data)],
            { type: response.speech.ContentType || 'audio/mpeg' }
          );

          const audioUrl = URL.createObjectURL(audioBlob);

          const audioElement = audioElementRef.current;
          if (audioElement) {
            audioElement.src = audioUrl;
            audioElement.onended = () => processAudioQueue();
            // Only play automatically if “isPlay” is true
            // if (isPlay) {
            //   audioElement.play();
            // }
            audioElement.play();
          }
          setTranslatedText((prev) => [...prev, response.translatedText]);
        } catch (error) {
          console.error('Failed to translate text to speech:', error);
        }
      };
      const currentText = transcripts.results[0].alternatives[0].transcript;
      transcriptListRef.current.push(currentText);
      transcriptList2Ref.current.push(currentText);
      audioQueueRef.current.push(currentText);
      audioQueue2Ref.current.push(currentText);
      if (audioQueueRef.current.length === 1) {
        processAudioQueue();  // Start processing the queue.
      }

      setTranscriptText((prev) => [...prev, currentText]);
    }
    // else {
    //   if (sourceLanguageCode === selectedVoiceLanguage) {
    //     const bindAudioElement = async () => {
    //       await meetingSession.audioVideo.bindAudioElement(audioElement);
    //     };
    //     bindAudioElement();
    //     //audioElement.play();
    //   }
    // }
  };

  // useEffect(() => {

  //   const audioElement = audioElementRef.current;
  //   if (!audioElement || !meetingSession || !sourceLanguageCode || !selectedVoiceLanguage) return;
  //   setTranscriptText([]);
  //   setTranslatedText([]);

  //   if (
  //     sourceLanguageCode !== selectedVoiceLanguage &&
  //     transcripts?.results?.[0]?.alternatives?.[0]?.transcript &&
  //     !transcripts.results[0].isPartial &&
  //     isPlay
  //   ) {
  //     // Process audio queue
  //     const processAudioQueue = async () => {
  //       if (audioQueueRef.current.length === 0) return;

  //       const nextAudio = audioQueueRef.current.shift();
  //       console.log("nextAudio", nextAudio);
  //       try {
  //         await translateAndPlay(nextAudio);
  //       } catch (error) {
  //         console.error('Error processing audio queue:', error);
  //       }

  //       //setImmediate(processAudioQueue);
  //       setTimeout(processAudioQueue, 0);
  //     };

  //     // Translate and play the audio
  //     const translateAndPlay = async (currentText) => {
  //       try {
  //         let targetLanguageCode = selectedVoiceLanguage;
  //         if (selectedVoiceLanguage === 'cmn-CN') {
  //           targetLanguageCode = "zh";
  //         }

  //         console.log('Check sourceLanguageCode:', sourceLanguageCode);
  //         console.log('Check targetLanguageCode:', targetLanguageCode);
  //         const response = await translateTextSpeech(
  //           currentText,
  //           sourceLanguageCode,
  //           targetLanguageCode,
  //           "standard"
  //         );

  //         console.log('Translated response:', response);
  //         translatedListRef.current.push(response.translatedText);

  //         if (!response.speech.AudioStream?.data)
  //           throw new Error('Invalid AudioStream data');

  //         const audioBlob = new Blob(
  //           [Uint8Array.from(response.speech.AudioStream.data)],
  //           { type: response.speech.ContentType || 'audio/mpeg' }
  //         );

  //         const audioUrl = URL.createObjectURL(audioBlob);

  //         const audioElement = audioElementRef.current;
  //         if (audioElement) {
  //           audioElement.src = audioUrl;
  //           audioElement.onended = () => processAudioQueue();
  //           // Only play automatically if “isPlay” is true
  //           // if (isPlay) {
  //           //   audioElement.play();
  //           // }
  //           audioElement.play();
  //         }
  //         setTranslatedText((prev) => [...prev, response.translatedText]);
  //       } catch (error) {
  //         console.error('Failed to translate text to speech:', error);
  //       }
  //     };
  //     const currentText = transcripts.results[0].alternatives[0].transcript;
  //     transcriptListRef.current.push(currentText);
  //     transcriptList2Ref.current.push(currentText);
  //     audioQueueRef.current.push(currentText);
  //     audioQueue2Ref.current.push(currentText);
  //     if (audioQueueRef.current.length === 1) {
  //       processAudioQueue();  // Start processing the queue.
  //     }

  //     setTranscriptText((prev) => [...prev, currentText]);
  //   }
  //   // else {
  //   //   if (sourceLanguageCode === selectedVoiceLanguage) {
  //   //     const bindAudioElement = async () => {
  //   //       await meetingSession.audioVideo.bindAudioElement(audioElement);
  //   //     };
  //   //     bindAudioElement();
  //   //     //audioElement.play();
  //   //   }
  //   // }
  // }, [
  //   meetingSession,
  //   transcripts,
  //   sourceLanguageCode,
  //   selectedVoiceLanguage,
  //   isPlay
  // ]);

  const handleSelectedVoiceLanguageChange = (event) => {
    setSelectedVoiceLanguage(event.target.value);
  };
  console.log('Check transcriptText:', transcriptText);
  console.log('Check transcriptText string:', transcriptText.join(' '));

  console.log('Check translatedText:', translatedText);
  console.log('Check translatedText string:', translatedText.join(' '));

  // const audioRef = useRef(null);
  const handleMuteUnmute = () => {
    setIsMuted(!isMuted);
    audioElementRef.current.muted = isMuted;
  };

  // Function to handle play/pause button click
  const handlePlay = async() => {
    console.log('Check src:', audioElementRef.current.src);
    const transcriptText = transcripts?.results?.[0]?.alternatives?.[0]?.transcript;

    if (!transcriptText?.trim()) {
      audioElementRef.current.srcObject = null; // Unbind
    }

    if (isPlay === false) {
      setIsPlay(true)
      audioElementRef.current.play();
      // Call the translation function when play is clicked
      //await callTranslateTextSpeech();
    } else {
      setIsPlay(false);
      audioElementRef.current.pause();
    }
  }

  // Function to join the audio session
  const joinAudioSession = useCallback(async () => {

    const getMeetingByTourIdResponse = await getMeetingByTourId(tourId);
    console.log('getMeetingByTourIdResponse', getMeetingByTourIdResponse);
    if (getMeetingByTourIdResponse?.statusCode === 200) {
      setChatRestriction(getMeetingByTourIdResponse.data.chatRestriction);
      setTour(getMeetingByTourIdResponse.data);
      console.log('Meeting found:', getMeetingByTourIdResponse.data.meetingId);

      if (getMeetingByTourIdResponse.data.meetingId) {
        console.log("Meeting Existed in Tour");
        const checkAvailableMeetingResponse = await getMeeting(getMeetingByTourIdResponse.data.meetingId);
        console.log('checkAvailableMeeting:', checkAvailableMeetingResponse);
        console.log('checkAvailableMeeting statusCode:', checkAvailableMeetingResponse.statusCode);
        if (checkAvailableMeetingResponse.statusCode === 404) {
          //toast.info('Guide does not start, please wait...');
          alert('Guide does not start, please wait...');
        } else if (checkAvailableMeetingResponse.statusCode === 200) {
          // Join the meeting again and set the meeting session in the state
          console.log('Meeting not expired:', checkAvailableMeetingResponse);
          console.log('Check checkAvailableMeetingResponse:', checkAvailableMeetingResponse.data);
          joinAudioSession2(checkAvailableMeetingResponse.data, getMeetingByTourIdResponse.data.channelId);

        } else {
          console.log('Meeting error:', checkAvailableMeetingResponse);
        }
      } else {
        alert('Guide does not start, please wait...');
      }
    } else {
      // alert('Tour not found, please check the tour ID.');
      console.log('Tour not found, please check the tour ID.');
      // toast.error('Tour not found, please check the tour ID.');
      setTour(null);
    }
  }, [joinAudioSession2, tourId]);

  // Call requestWakeLock once the meeting session is set:
  useEffect(() => {
    if (meetingSession) {
      requestWakeLock();
      // document.addEventListener('visibilitychange', async () => {
      //   if (wakeLockRef.current && document.visibilityState === 'visible') {
      //     await requestWakeLock();
      //   }
      // });
    }
  }, [meetingSession, requestWakeLock]);

  // Handle long text for translations and transcriptions
  const isLongText = translatedListRef.current.join(' ').length > 300;

  // Check if the tour exists, if not, show a not found page
  if (tour === null) {
    return <NotFound />;
  }

  console.log("transcripts event:", transcripts);
  console.log("transcripts:", transcripts?.results?.[0]?.alternatives?.[0]?.transcript);
  console.log("transcripts isPartial:", transcripts?.results?.[0]?.isPartial);

  return (
    <>
      <Header count={participantsCount} tourId={tourId} userType={userType} />
      {/* <div className="live-viewer-container"> */}
      <div className={` ${meeting && attendee ? 'live-viewer-container' : 'live-viewer-container-center'}`}>
        {/* <div className='live-viewer-title'>
          <div className='time'>
            <span>2025年1月1日</span>
          </div>

          <span className='name-tour'>浅草寺ツアー</span>
        </div> */}
        <TourTitle tour={tour} />
        {!meeting && !attendee && (
          <div className="box-selected-language">
            <h3 className='title-box'>
              {t('voiceLanguageLbl.listening')}
            </h3>
            <select
              className='selected-language'
              id="selectedVoiceLanguage"
              value={selectedVoiceLanguage}
              onChange={handleSelectedVoiceLanguageChange}
            >
              {(i18n.language === 'ja' ? JA_LISTEN_VOICE_LANGUAGES : LISTEN_VOICE_LANGUAGES).map((language) => (
                <option key={language.key} value={language.key}>
                  {language.label}
                </option>
              ))}

            </select>
          </div>
        )}
        <audio
          id="audioElementListener"
          //controls
          ref={audioElementRef}
          //autoPlay
          //className="audio-player"
          style={{ display: 'none' }}
        />

        {!meeting && !attendee ? (
          isLoading ? (
            <div className="loading">
              <div className="spinner"></div>
              <p>{t('loading')}</p>
            </div>
          ) : (
            <div className='btn' onClick={joinAudioSession}>
              <button className='btn-join'>{t('joinBtn')}</button>
            </div>
          )
        ) : (
          <>
            <div className='audioViewer'>
              {!!isPlay ? <div>
                <div className='pauseButtonViewer' onClick={handlePlay}>
                  {/* {isPlay ? <FaPause size={30} /> : <IoPlay size={30} />} */}
                  <FaPause size={20} />
                  <span className="startText">{t('stopBtn')}</span>
                </div>
              </div>
                : <div>
                  <div className='playButtonViewer' onClick={handlePlay}>
                    {/* {isPlay ? <FaPause size={30} /> : <IoPlay size={30} />} */}
                    <FaPlay size={20} />
                    <span className="startText">{t('startBtn')}</span>
                  </div>
                </div>}
              <div className='soundButton' onClick={handleMuteUnmute}>
                {isMuted ? <HiMiniSpeakerWave size={30} /> : <IoVolumeMute size={30} />
                }
              </div>
              {/* <audio id='audioElementListener' ref={audioElementRef} >
              </audio> */}
            </div>
            {transcriptListRef.current.length > 0 && (
              <div className='trans-box'>
                <div style={{ textAlign: 'center', fontWeight: '700' }}>
                  <p>{t('captureTranslations')}</p>
                </div>
                {/* <p>
                The host is speaking in{' '}
                {LISTEN_VOICE_LANGUAGES.find((lang) => lang.key === sourceLanguageCode)?.label}.
              </p>
              <p>
                I am listening in{' '}
                {LISTEN_VOICE_LANGUAGES.find((lang) => lang.key === selectedVoiceLanguage)?.label}.
              </p> */}
                {translatedListRef.current.length > 0 && (

                  <div className='trans-text-box'>
                    <div className={` ${isLongText ? 'long-text' : 'short-text'}`}></div>
                    <span className='trans-text'>
                      {t('translations')}: <span>{translatedListRef.current.join(' ')}</span>
                    </span>
                  </div>

                )}
                {transcriptListRef.current.length > 0 && (

                  <div className='trans-text-box'>
                    {/* <div className="blur-mask"></div> */}
                    <div className={` ${isLongText ? 'long-text' : 'short-text'}`}></div>
                    <span className='trans-text'>
                      {t('transcriptions')}: <span>{transcriptListRef.current.join(' ')}</span>
                    </span>
                  </div>
                )}
                <br />

                <br />
              </div>
            )}

            {/* <div>
              {channelArn && (
                <ChatMessage
                  userArn={userArn}
                  sessionId={Config.sessionId}
                  channelArn={channelArn}
                  chatSetting={chatSetting}
                />
              )}
            </div> */}
            {chatRestriction !== "nochat" && (<MessageBox userArn={userArn} sessionId={Config.sessionId} channelArn={channelArn} userType={userType} statusChat={chatRestriction} />)}
          </>
        )}
      </div>

    </>
  );
}

export default LiveViewer2;
