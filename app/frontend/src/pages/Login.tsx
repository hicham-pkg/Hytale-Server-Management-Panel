import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { AlertTriangle, Loader2, Server, Lock } from 'lucide-react';

export default function LoginPage() {
  const { login, verifyTotp } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(username, password);
      if (result.error) {
        setError(result.error);
      } else if (result.requires2fa) {
        setStep('totp');
      } else {
        navigate('/');
      }
    } catch {
      setError('Connection failed. Is the server running?');
    } finally {
      setLoading(false);
    }
  };

  const handleTotp = async () => {
    if (totpCode.length !== 6) return;
    setError('');
    setLoading(true);

    try {
      const result = await verifyTotp(totpCode);
      if (result.error) {
        setError(result.error);
        setTotpCode('');
      } else {
        navigate('/');
      }
    } catch {
      setError('Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <Server className="h-8 w-8 text-indigo-400" />
          <h1 className="text-2xl font-bold text-white">Hytale Panel</h1>
        </div>

        <Card className="bg-[#12121a] border-[#2a2a3e]">
          {step === 'credentials' ? (
            <>
              <CardHeader className="pb-4">
                <CardTitle className="text-white text-lg">Sign In</CardTitle>
                <CardDescription className="text-slate-400">
                  Enter your credentials to access the panel
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="username" className="text-slate-300">
                      Username
                    </Label>
                    <Input
                      id="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="admin"
                      required
                      autoFocus
                      className="bg-[#0a0a0f] border-[#2a2a3e] text-white placeholder:text-slate-600 focus:border-indigo-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-slate-300">
                      Password
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="bg-[#0a0a0f] border-[#2a2a3e] text-white placeholder:text-slate-600 focus:border-indigo-500"
                    />
                  </div>

                  {error && (
                    <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 p-3 rounded-md">
                      <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}

                  <Button
                    type="submit"
                    disabled={loading || !username || !password}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Sign In
                  </Button>
                </form>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="pb-4">
                <CardTitle className="text-white text-lg flex items-center gap-2">
                  <Lock className="h-5 w-5 text-indigo-400" />
                  Two-Factor Auth
                </CardTitle>
                <CardDescription className="text-slate-400">
                  Enter the 6-digit code from your authenticator app
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-center">
                  <InputOTP
                    maxLength={6}
                    value={totpCode}
                    onChange={(val) => {
                      setTotpCode(val);
                      if (val.length === 6) {
                        setTimeout(() => handleTotp(), 100);
                      }
                    }}
                  >
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((i) => (
                        <InputOTPSlot
                          key={i}
                          index={i}
                          className="bg-[#0a0a0f] border-[#2a2a3e] text-white"
                        />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 p-3 rounded-md">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {loading && (
                  <div className="flex justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
                  </div>
                )}

                <Button
                  variant="ghost"
                  onClick={() => {
                    setStep('credentials');
                    setError('');
                    setTotpCode('');
                  }}
                  className="w-full text-slate-400 hover:text-white"
                >
                  Back to login
                </Button>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}