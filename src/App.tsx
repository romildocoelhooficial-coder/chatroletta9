import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { Navbar } from './components/Navbar.tsx';
import { RouletteView } from './components/RouletteView.tsx';
import { DirectCallView } from './components/DirectCallView.tsx';
import { AdminDashboard } from './components/AdminDashboard.tsx';
import { IncomingCallModal } from './components/IncomingCallModal.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { ReportModal } from './components/ReportModal.tsx';
import { socketService } from './services/socket.ts';
import { sounds } from './services/audio.ts';
import { Ban } from 'lucide-react';

function MainApp() {
  const { user, bannedReason, clearBanNotice } = useAuth();
  const socket = socketService.getSocket();

  const [currentTab, setCurrentTab] = useState<'roulette' | 'direct' | 'admin'>('roulette');
  const [isAuthOpen, setIsAuthOpen] = useState(false);

  // Incoming Call State (1:1 or Group Call Invite)
  const [incomingCall, setIncomingCall] = useState<{
    callId: string;
    inviteId?: string;
    roomId?: string;
    isGroupInvite?: boolean;
    participants?: { username: string; unique_code: string }[];
    callerSocketId: string;
    caller: {
      id: string;
      username: string;
      unique_code: string;
      avatar?: string;
      country?: string;
    };
    callType: 'video' | 'audio';
    isMock?: boolean;
  } | null>(null);

  // Active accepted session passed to DirectCallView
  const [activeCallSession, setActiveCallSession] = useState<any>(null);

  // Report Modal State
  const [reportData, setReportData] = useState<{ code: string; name: string } | null>(null);

  // Global listeners for Incoming Calls (Socket.io + Offline BroadcastChannel)
  useEffect(() => {
    const onIncomingCall = (data: {
      callId: string;
      inviteId?: string;
      roomId?: string;
      isGroupInvite?: boolean;
      participants?: { username: string; unique_code: string }[];
      callerSocketId: string;
      caller: any;
      callType: 'video' | 'audio';
    }) => {
      console.log('[MainApp] Incoming Call received via Socket:', data);
      sounds.unlockAudio();
      sounds.startIncomingRing();
      setIncomingCall(data);
    };

    const onCallEnded = (data?: { callId?: string }) => {
      setIncomingCall((prev) => {
        if (!prev) return null;
        if (data?.callId && prev.callId !== data.callId) return prev;
        sounds.stopAll();
        return null;
      });
    };

    const onDismissIncoming = (data: { callId: string }) => {
      setIncomingCall((prev) => {
        if (prev && (prev.callId === data.callId || prev.inviteId === data.callId)) {
          sounds.stopAll();
          return null;
        }
        return prev;
      });
    };

    socket.on('call:incoming', onIncomingCall);
    socket.on('call:ended', onCallEnded);
    socket.on('call:dismiss_incoming', onDismissIncoming);

    // Cross-tab BroadcastChannel fallback (only active when Socket.IO server is unreachable)
    const onBroadcastCall = (payload: {
      targetCode: string;
      callId: string;
      caller: any;
      callType: 'video' | 'audio';
      callerSocketId: string;
    }) => {
      if (socketService.isConnected) return;
      if (user && payload.targetCode.toUpperCase() === user.unique_code.toUpperCase()) {
        console.log('[MainApp] Incoming Call received via Offline Broadcast:', payload);
        sounds.unlockAudio();
        sounds.startIncomingRing();
        setIncomingCall({
          callId: payload.callId,
          callerSocketId: payload.callerSocketId || 'cross_tab',
          caller: payload.caller,
          callType: payload.callType || 'video',
        });
      }
    };

    socketService.onLocal('call:incoming_broadcast', onBroadcastCall);

    return () => {
      socket.off('call:incoming', onIncomingCall);
      socket.off('call:ended', onCallEnded);
      socket.off('call:dismiss_incoming', onDismissIncoming);
      socketService.offLocal('call:incoming_broadcast', onBroadcastCall);
    };
  }, [socket, user]);

  // Handle Accept Incoming Call
  const handleAcceptCall = () => {
    if (!incomingCall) return;
    sounds.stopAll();
    sounds.playConnectedChime();

    if (incomingCall.isMock || incomingCall.callerSocketId === 'mock_caller') {
      setActiveCallSession({
        callId: incomingCall.callId,
        caller: incomingCall.caller,
        callerSocketId: 'mock_caller',
        isMock: true,
        acceptedAt: Date.now(),
      });
      setIncomingCall(null);
      setCurrentTab('direct');
      return;
    }

    if (incomingCall.isGroupInvite && incomingCall.roomId) {
      socket.emit('call:accept_invite', {
        inviteId: incomingCall.inviteId || incomingCall.callId,
        roomId: incomingCall.roomId,
        callId: incomingCall.callId,
        hostSocketId: incomingCall.callerSocketId,
      });

      setActiveCallSession({
        callId: incomingCall.callId,
        roomId: incomingCall.roomId,
        caller: incomingCall.caller,
        callerSocketId: incomingCall.callerSocketId,
        isGroupInvite: true,
        acceptedAt: Date.now(),
      });
    } else {
      socket.emit('call:accept', {
        callId: incomingCall.callId,
        callerSocketId: incomingCall.callerSocketId,
      });

      if (!socketService.isConnected) {
        socketService.broadcastLocal('call:accepted_broadcast', {
          callId: incomingCall.callId,
          receiverCode: user?.unique_code,
        });
      }

      setActiveCallSession({
        callId: incomingCall.callId,
        caller: incomingCall.caller,
        callerSocketId: incomingCall.callerSocketId,
        acceptedAt: Date.now(),
      });
    }

    setIncomingCall(null);
    setCurrentTab('direct');
  };

  // Handle Decline Incoming Call
  const handleDeclineCall = () => {
    if (!incomingCall) return;
    sounds.stopAll();
    sounds.playHangupTone();

    if (!incomingCall.isMock && incomingCall.callerSocketId !== 'mock_caller') {
      if (incomingCall.isGroupInvite) {
        socket.emit('call:reject_invite', {
          inviteId: incomingCall.inviteId || incomingCall.callId,
          hostSocketId: incomingCall.callerSocketId,
          reason: 'Convite recusado pelo usuário.',
        });
      } else {
        socket.emit('call:reject', {
          callId: incomingCall.callId,
          callerSocketId: incomingCall.callerSocketId,
          reason: 'Chamada recusada pelo usuário.',
        });

        if (!socketService.isConnected) {
          socketService.broadcastLocal('call:rejected_broadcast', {
            callId: incomingCall.callId,
          });
        }
      }
    }

    setIncomingCall(null);
  };

  // Simulated Incoming Call (Test helper)
  const handleTriggerTestIncomingCall = () => {
    sounds.unlockAudio();
    sounds.startIncomingRing();
    setIncomingCall({
      callId: `test_call_${Date.now()}`,
      callerSocketId: 'mock_caller',
      isMock: true,
      caller: {
        id: 'user_002',
        username: 'Lucas Silva (Chamada de Teste)',
        unique_code: '#CR-849201',
        country: 'Brasil 🇧🇷',
        avatar: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop&q=80',
      },
      callType: 'video',
    });
  };

  // Trigger Report Modal
  const handleOpenReport = (code: string, name: string) => {
    setReportData({ code, name });
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Navbar */}
      <Navbar
        currentTab={currentTab}
        onSelectTab={(tab) => setCurrentTab(tab)}
        onOpenAuth={() => setIsAuthOpen(true)}
      />

      {/* Main View Container */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {currentTab === 'roulette' && (
          <RouletteView onReportUser={handleOpenReport} />
        )}

        {currentTab === 'direct' && (
          <DirectCallView
            onReportUser={handleOpenReport}
            activeIncomingCallSession={activeCallSession}
            onClearIncomingSession={() => setActiveCallSession(null)}
            onTriggerTestIncomingCall={handleTriggerTestIncomingCall}
          />
        )}

        {currentTab === 'admin' && <AdminDashboard />}
      </main>

      {/* Incoming Call Modal (Telephone Ringing Popup with Atender / Recusar) */}
      <IncomingCallModal
        isOpen={!!incomingCall}
        caller={incomingCall?.caller || null}
        callType={incomingCall?.callType || 'video'}
        isGroupInvite={incomingCall?.isGroupInvite}
        participants={incomingCall?.participants}
        onAccept={handleAcceptCall}
        onDecline={handleDeclineCall}
      />

      {/* Auth Modal (Login, Signup, Demo accounts) */}
      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
      />

      {/* Report Modal */}
      <ReportModal
        isOpen={!!reportData}
        reportedCode={reportData?.code}
        reportedName={reportData?.name}
        onClose={() => setReportData(null)}
      />

      {/* Real-time Banned Notification Modal */}
      {bannedReason && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
          <div className="relative w-full max-w-md bg-zinc-900 border-2 border-red-500/60 rounded-3xl p-6 text-center shadow-2xl">
            <div className="w-16 h-16 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/40">
              <Ban className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Conta Suspensa pela Moderação</h3>
            <p className="text-xs text-red-300 bg-red-950/50 p-3 rounded-xl border border-red-500/30 mb-4">
              Motivo: {bannedReason}
            </p>
            <p className="text-xs text-zinc-400 mb-6">
              Sua conexão com as salas de vídeo foi interrompida de acordo com os termos de convivência da plataforma.
            </p>
            <button
              onClick={clearBanNotice}
              className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold rounded-xl text-xs transition"
            >
              Compreendi e Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );
}
