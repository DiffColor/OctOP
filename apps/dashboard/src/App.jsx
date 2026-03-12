import { useState } from "react";

function LoginPage({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);

  const handleSubmit = (event) => {
    event.preventDefault();

    if (!email || !password) {
      return;
    }

    onSuccess({ email, rememberDevice });
  };

  return (
    <div className="relative min-h-screen bg-brand-dark text-slate-200 font-sans flex items-center justify-center p-4 overflow-hidden">
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="bg-mesh absolute inset-0" />
        <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] bg-brand-accent opacity-10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-600 opacity-10 blur-[120px] rounded-full" />
      </div>

      <main className="w-full max-w-md" data-purpose="login-container">
        <header className="text-center mb-10" data-purpose="login-header">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-tr from-brand-accent to-purple-500 rounded-2xl mb-6 shadow-lg shadow-brand-accent/20">
            <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2 font-display">OctOP</h1>
          <p className="text-slate-400">Scale your AI orchestration with intelligence.</p>
        </header>

        <section className="glass-effect p-8 rounded-3xl shadow-2xl" data-purpose="login-card">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2" htmlFor="email">
                Work Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder="name@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-brand-dark border border-slate-700 text-white focus:ring-2 focus:ring-brand-accent focus:border-transparent transition-all duration-200 outline-none"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-sm font-medium text-slate-300" htmlFor="password">
                  Password
                </label>
                <a href="#" className="text-xs font-semibold text-brand-accent hover:text-brand-glow transition-colors">
                  Forgot password?
                </a>
              </div>
              <input
                id="password"
                name="password"
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-brand-dark border border-slate-700 text-white focus:ring-2 focus:ring-brand-accent focus:border-transparent transition-all duration-200 outline-none"
              />
            </div>

            <div className="flex items-center">
              <input
                id="remember-me"
                name="remember-me"
                type="checkbox"
                className="h-4 w-4 rounded border-slate-700 bg-brand-dark text-brand-accent focus:ring-brand-accent focus:ring-offset-brand-dark"
                checked={rememberDevice}
                onChange={(event) => setRememberDevice(event.target.checked)}
              />
              <label htmlFor="remember-me" className="ml-2 block text-sm text-slate-400">
                Remember this device
              </label>
            </div>

            <button
              type="submit"
              className="w-full py-3 px-4 rounded-xl bg-brand-accent hover:bg-indigo-500 text-white font-bold text-lg shadow-lg shadow-brand-accent/25 transform transition active:scale-[0.98] duration-200"
            >
              Sign In
            </button>
          </form>

          <div className="relative my-8">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-700" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-brand-surface text-slate-500 rounded-full glass-effect">Or continue with</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4" data-purpose="social-auth-buttons">
            <button
              type="button"
              className="flex items-center justify-center py-2.5 px-4 rounded-xl border border-slate-700 hover:bg-slate-800 transition-colors duration-200"
            >
              <img
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuB2eKGEzBfd8bSm9RyXkwkpENR94QTpx5z8QZIfOhUBXH_7FE3wq3Ii5SWG88-kodC6f-jAX2ldvESYqbVSOSEwQuAcO9tXfqjBHwseEq2qf3QAw-_JTYszceQ_xX5965yLXlED-cB56jMJ0rh3VR43R1fxrXBocGPzbJamleB_StVCWcrMCUfIptP_vIqx7mMMxwNGyEKBB2gPKrmWL_DHcX4RXNA_By7Scq4y6HriVO4TmJvBsLXtRdXCbvhtuHwnHbdt8fpGx8Y"
                alt="Google Logo"
                className="w-5 h-5 mr-2"
              />
              <span className="text-sm font-medium">Google</span>
            </button>
            <button
              type="button"
              className="flex items-center justify-center py-2.5 px-4 rounded-xl border border-slate-700 hover:bg-slate-800 transition-colors duration-200"
            >
              <svg className="w-5 h-5 mr-2 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                />
              </svg>
              <span className="text-sm font-medium">GitHub</span>
            </button>
          </div>
        </section>

        <footer className="mt-8 text-center text-sm text-slate-500" data-purpose="login-footer">
          Don't have an account?{" "}
          <a href="#" className="font-semibold text-brand-accent hover:text-brand-glow transition-colors">
            Start your 14-day free trial
          </a>
        </footer>
      </main>
    </div>
  );
}

function MainPage() {
  return (
    <div className="min-h-screen h-full bg-slate-900 text-slate-200 font-sans selection:bg-octo-blue/30 overflow-hidden">
      <div className="flex h-full" data-purpose="app-container">
        <aside className="w-64 bg-octo-dark border-r border-slate-800 flex flex-col hidden md:flex" data-purpose="navigation-sidebar">
          <div className="p-6 flex items-center space-x-3">
            <div className="w-8 h-8 bg-gradient-to-br from-octo-blue to-octo-purple rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">OctOP</span>
          </div>

          <nav className="flex-1 px-4 space-y-1 mt-4">
            <a
              href="#"
              className="flex items-center px-3 py-2 text-sm font-medium rounded-md bg-slate-800 text-white ai-glow"
            >
              <svg className="w-5 h-5 mr-3 text-octo-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Projects
            </a>
            <a
              href="#"
              className="flex items-center px-3 py-2 text-sm font-medium rounded-md text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Orchestrators
            </a>
            <a
              href="#"
              className="flex items-center px-3 py-2 text-sm font-medium rounded-md text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Analytics
            </a>
            <a
              href="#"
              className="flex items-center px-3 py-2 text-sm font-medium rounded-md text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Settings
            </a>
          </nav>

          <div className="p-4 border-t border-slate-800 mt-auto">
            <div className="flex items-center">
              <img
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuAqiAAApAOqanMWsPsltijAnFAGxW8LLnowQR5DoIeFdVIjjLqZNdCAfPR0BiFCL3GTUzIVAtDa9NC-EHBZbM9vkhz5PiI-112imRbh338KnO1MUCj7U1UwuEL1a7XbTFpgaHgylGR0-XmGxxJBbG4ZTVss-3vA7o3XuytxgGF1_LW8O0vkWG6a8PawFlgarDPR1EyPLF8Tl5h2xyQOnYf1uz4pMrZhEvZis_36T-ZhqH1LQVrzp7cyasNmvdke6N51vasI-Pt5mzw"
                alt="User Avatar"
                className="h-8 w-8 rounded-full ring-2 ring-octo-blue/20"
              />
              <div className="ml-3">
                <p className="text-xs font-semibold text-white">Project Manager</p>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">Enterprise Plan</p>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0 bg-slate-900 overflow-hidden">
          <header
            className="h-16 border-b border-slate-800 bg-octo-dark/50 backdrop-blur-md flex items-center justify-between px-8 sticky top-0 z-10"
            data-purpose="top-navigation"
          >
            <div className="flex items-center space-x-2 text-sm">
              <span className="text-slate-500">Projects</span>
              <span className="text-slate-700">/</span>
              <span className="text-white font-medium">Neural-Net-Optimization</span>
            </div>
            <div className="flex items-center space-x-6">
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg
                    className="h-4 w-4 text-slate-500 group-focus-within:text-octo-blue transition-colors"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <input
                  type="text"
                  placeholder="Search tasks..."
                  className="bg-slate-800 border-transparent focus:ring-1 focus:ring-octo-blue focus:border-octo-blue block w-64 pl-10 sm:text-sm rounded-lg text-slate-300 transition-all"
                />
              </div>
              <button
                type="button"
                className="bg-octo-blue hover:bg-sky-500 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center transition-all shadow-lg shadow-octo-blue/20"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M12 4v16m8-8H4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                New Issue
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-x-auto p-8 custom-scrollbar" data-purpose="kanban-container">
            <div className="flex space-x-6 h-full min-w-max">
              <section className="w-80 flex flex-col" data-purpose="kanban-column">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="flex items-center text-sm font-bold text-slate-400 uppercase tracking-widest">
                    <span className="w-2 h-2 rounded-full bg-slate-400 mr-2" />
                    To Do
                    <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-800 text-[10px]">3</span>
                  </h3>
                </div>
                <div className="kanban-column space-y-4 rounded-xl">
                  <div className="bg-octo-card p-4 rounded-xl border border-slate-800 hover:border-slate-700 transition-all cursor-pointer shadow-sm group">
                    <div className="flex justify-between items-start mb-2">
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-orange-500/10 text-orange-500 uppercase tracking-tighter">
                        High
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">OCTO-102</span>
                    </div>
                    <h4 className="text-sm font-medium text-slate-200 mb-4 group-hover:text-octo-blue transition-colors">
                      Implement Vector Embedding Cache
                    </h4>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center text-[10px] text-slate-500">
                        <svg className="w-3 h-3 mr-1 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        AI Suggested
                      </div>
                      <img
                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuBqMsP1Z0p-Wpi8wq8wijrIdV3jIRjnYCj-IAlY6Mlfea1bNgUBdPHeTbK2k3fLsUHqVSa5gIZZDlOHTUsgbGN3_8dbiuEF4oC5iM-xyVMQgg5EgGid_DEgtCTe_iiE5xale740sY1SOuKIogIdA_uW-PwvnZkFgek0UiIzj2_fwyQoyMIYCEqfoHqN2PUahXB-3ruXFtMTfgu3ebMQ230YJJTm_r3E3x1hZiu7uXAuoouWas-4nbJ5L0i9vW8_3Cn8yvSju7k8uJI"
                        alt="Assignee"
                        className="w-6 h-6 rounded-full border border-slate-700"
                      />
                    </div>
                  </div>

                  <div className="bg-octo-card p-4 rounded-xl border border-slate-800 hover:border-slate-700 transition-all cursor-pointer shadow-sm group">
                    <div className="flex justify-between items-start mb-2">
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-blue-500/10 text-blue-500 uppercase tracking-tighter">
                        Med
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">OCTO-105</span>
                    </div>
                    <h4 className="text-sm font-medium text-slate-200 mb-4 group-hover:text-octo-blue transition-colors">
                      Update Model API Endpoints
                    </h4>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center text-[10px] text-slate-500">
                        <svg className="w-3 h-3 mr-1 text-slate-600" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" />
                        </svg>
                        Manual
                      </div>
                      <img
                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuC5TK9mccrSlCU_VyiHhq2W7xK8n-sRJuTa7lE3bf2_ASpcdKf7DvjdW6zvwtQo3nKC6ErT5-oZM4QccXhuvawvFimhNsIFLmIROhzmQbGupbuGVfwpZNyaMQBujxPK03_JmcpoJky6soemJrAUfkktgqTLkIA8RFU4qQxvyS_d8_i9vSNvO--Q8Zjsh8fNOsNmZpnROmM2KAJDnW9ofbaKF4GdlZWZmXUXx0ObxUKs_LTVwVptEk8lWIKg6wWPX6OOMHd2KRWkrzA"
                        alt="Assignee"
                        className="w-6 h-6 rounded-full border border-slate-700"
                      />
                    </div>
                  </div>
                </div>
              </section>

              <section className="w-80 flex flex-col" data-purpose="kanban-column">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="flex items-center text-sm font-bold text-octo-blue uppercase tracking-widest">
                    <span className="w-2 h-2 rounded-full bg-octo-blue mr-2 animate-pulse" />
                    In Progress
                    <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-800 text-[10px]">1</span>
                  </h3>
                </div>
                <div className="kanban-column space-y-4">
                  <div className="bg-octo-card p-4 rounded-xl border border-octo-blue/30 shadow-lg shadow-octo-blue/5 group">
                    <div className="flex justify-between items-start mb-2">
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-red-500/10 text-red-500 uppercase tracking-tighter">
                        Critical
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">OCTO-98</span>
                    </div>
                    <h4 className="text-sm font-medium text-slate-200 mb-2">Refactor Tokenizer Middleware</h4>
                    <div className="mb-4">
                      <div className="flex justify-between text-[10px] mb-1">
                        <span className="text-octo-blue font-semibold">AI Agent Working...</span>
                        <span className="text-slate-500">65%</span>
                      </div>
                      <div className="w-full bg-slate-800 rounded-full h-1">
                        <div className="bg-gradient-to-r from-octo-blue to-octo-purple h-1 rounded-full" style={{ width: "65%" }} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center text-[10px] text-octo-blue">
                        <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        Automated
                      </div>
                      <img
                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuAIYk9yLvtWc6meRXLDf0_UUtL3AL1bBzXsn8g1_MswTvVPFIh0XYQoK9GUdb-x1HgTh2742_d3xM7t16SuplRoRncukbW2Rvcfh0xexauULN-Xvu9hvXJa_Yey5w7ny_XIIyNAENs0QAKBNxDtLAdnzUPRyj5_Az2VMR0lJHfNUPpCqePVb5hiQAVL-j4sHi9uzP8zaomwstqWjqPEMfnmjGjMlGgdnSGdSlR12qP4lEsXK-IeCIm4xrjIv1KX_D0vFmOgiPl6ISI"
                        alt="Assignee"
                        className="w-6 h-6 rounded-full border-2 border-octo-blue"
                      />
                    </div>
                  </div>
                </div>
              </section>

              <section className="w-80 flex flex-col" data-purpose="kanban-column">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="flex items-center text-sm font-bold text-octo-purple uppercase tracking-widest">
                    <span className="w-2 h-2 rounded-full bg-octo-purple mr-2" />
                    Review
                    <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-800 text-[10px]">2</span>
                  </h3>
                </div>
                <div className="kanban-column space-y-4">
                  <div className="bg-octo-card p-4 rounded-xl border border-slate-800 hover:border-slate-700 transition-all cursor-pointer shadow-sm group">
                    <div className="flex justify-between items-start mb-2">
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-blue-500/10 text-blue-500 uppercase tracking-tighter">
                        Med
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">OCTO-92</span>
                    </div>
                    <h4 className="text-sm font-medium text-slate-200 mb-4 group-hover:text-octo-blue transition-colors">
                      Setup CI/CD for Model Testing
                    </h4>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center text-[10px] text-green-500">
                        <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        AI Verified
                      </div>
                      <img
                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuA5ToSkhaTy6URHx2EdLZ8WYsHnWjwGrxdgzbCp9apU-hb2M3es-sRheZ3CbFnvskjHMAXzOEBAv7mYrtfZQuL1teMug7-TXSngzuPv_PUiOuNXnVs7kZvmEFRG1qnADAYhygErjM9_89OrqMzwgSDQYknm_ePQmndfd4sMN8sHthCHzWi_k76G2ii4z3MtSb2SR39CiNTaTu2eBWqrDVL1v2u4Vq8B2iJqonoe6F00nfCu3rdhf3mG6zZhMr_S8zxxvA2xEeQoi_Y"
                        alt="Assignee"
                        className="w-6 h-6 rounded-full border border-slate-700"
                      />
                    </div>
                  </div>
                </div>
              </section>

              <section className="w-80 flex flex-col" data-purpose="kanban-column">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="flex items-center text-sm font-bold text-green-500 uppercase tracking-widest">
                    <span className="w-2 h-2 rounded-full bg-green-500 mr-2" />
                    Done
                    <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-800 text-[10px]">12</span>
                  </h3>
                </div>
                <div className="kanban-column space-y-4">
                  <div className="bg-octo-card/50 p-4 rounded-xl border border-slate-800/50 opacity-60 hover:opacity-100 transition-all cursor-pointer group">
                    <div className="flex justify-between items-start mb-2">
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-slate-700 text-slate-400 uppercase tracking-tighter line-through">
                        Low
                      </span>
                      <span className="text-[10px] font-mono text-slate-600">OCTO-84</span>
                    </div>
                    <h4 className="text-sm font-medium text-slate-400 mb-4 group-hover:text-octo-blue transition-colors">
                      Documentation Cleanup
                    </h4>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center text-[10px] text-slate-600">
                        <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path d="M5 13l4 4L19 7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Completed
                      </div>
                      <img
                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuC-KK_bnsh1yTN9GRs4Hr34PWBTZT58OLUb7trQ8YDjwIWVjNmEzozsxKr4ejog-nKTHUV9m5TXEbEr0Ft5-4NHtxr1M9miobEjUn4VotCOvQPzT2rhcrtIsn2I_3F8M_nFf_tE22UB17e6hesLBCJC0E1KsJse7_CmdPcWDN7wtnkwzvL_ofdVnpfIMwW6axvIlntx-7EAC3GHT6o1gWSPbFJUm8DUD8aELX_f11UqebHi-wnM0gP9i2QnOd9k8iQusAeNqcAIB74"
                        alt="Assignee"
                        className="w-6 h-6 rounded-full border border-slate-700 grayscale"
                      />
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState("login");

  if (screen === "login") {
    return <LoginPage onSuccess={() => setScreen("dashboard")} />;
  }

  return <MainPage />;
}
