export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 to-purple-900 flex items-center justify-center p-4">
      <main className="text-center max-w-2xl w-full bg-white/10 backdrop-blur-lg rounded-2xl p-12 border border-white/20 shadow-2xl">
        <h1 className="text-5xl font-black mb-6 text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-500">
          TenkaCloud
        </h1>
        <p className="text-2xl text-white mb-2 font-light">
          クラウド天下一武道会
        </p>
        <p className="text-indigo-200 mb-12">
          最強のクラウドエンジニアを目指せ
        </p>

        <div className="space-y-4">
          <button className="w-full bg-yellow-500 hover:bg-yellow-400 text-indigo-900 font-bold py-4 px-8 rounded-xl text-lg transition-all transform hover:scale-105 shadow-lg">
            バトルに参加する
          </button>
          <button className="w-full bg-white/10 hover:bg-white/20 text-white font-semibold py-4 px-8 rounded-xl text-lg transition-all border border-white/10">
            観戦モード
          </button>
        </div>

        <div className="mt-12 grid grid-cols-3 gap-4 text-center text-white/60 text-sm">
          <div>
            <div className="font-bold text-white text-xl mb-1">Active</div>
            <div>Status</div>
          </div>
          <div>
            <div className="font-bold text-white text-xl mb-1">128</div>
            <div>Participants</div>
          </div>
          <div>
            <div className="font-bold text-white text-xl mb-1">12</div>
            <div>Problems</div>
          </div>
        </div>
      </main>
    </div>
  );
}
