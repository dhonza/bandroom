// Thin C API around Signalsmith Stretch for BandRoom (browser decoder worker and Node bounce).
// One handle per track. Buffers are planar float32 and owned by the instance, so the JS side
// writes input into `br_input()` and reads output from `br_output()` without allocating.
#include "signalsmith-stretch.h"

#include <cstdlib>
#include <new>
#include <vector>

namespace {

using Stretch = signalsmith::stretch::SignalsmithStretch<float>;

// Fixed seed: the phase randomisation used above 2x stretch must be reproducible, so the
// Player and the bounce render the same samples.
constexpr long kSeed = 0x4252;

struct Instance {
	Stretch stretch{kSeed};
	int channels = 0;
	int maxIn = 0;
	int maxOut = 0;
	std::vector<float> in;
	std::vector<float> out;
	std::vector<float *> inPtr;
	std::vector<float *> outPtr;
};

} // namespace

extern "C" {

// Creates an instance. `blockSamples`/`intervalSamples` select the quality (see profiles.ts);
// `maxIn`/`maxOut` are the largest frame counts passed to one call.
__attribute__((used)) Instance *br_create(int channels, int blockSamples, int intervalSamples,
		int splitComputation, int maxIn, int maxOut) {
	Instance *s = new (std::nothrow) Instance();
	if (!s) return nullptr;
	s->channels = channels;
	s->maxIn = maxIn;
	s->maxOut = maxOut;
	s->in.assign(size_t(channels) * size_t(maxIn), 0.f);
	s->out.assign(size_t(channels) * size_t(maxOut), 0.f);
	for (int c = 0; c < channels; ++c) {
		s->inPtr.push_back(s->in.data() + size_t(c) * size_t(maxIn));
		s->outPtr.push_back(s->out.data() + size_t(c) * size_t(maxOut));
	}
	s->stretch.configure(channels, blockSamples, intervalSamples, splitComputation != 0);
	return s;
}

__attribute__((used)) void br_destroy(Instance *s) { delete s; }

__attribute__((used)) float *br_input(Instance *s) { return s->in.data(); }
__attribute__((used)) float *br_output(Instance *s) { return s->out.data(); }

__attribute__((used)) int br_block_samples(Instance *s) { return s->stretch.blockSamples(); }
__attribute__((used)) int br_interval_samples(Instance *s) { return s->stretch.intervalSamples(); }
__attribute__((used)) int br_input_latency(Instance *s) { return s->stretch.inputLatency(); }
__attribute__((used)) int br_output_latency(Instance *s) { return s->stretch.outputLatency(); }

// `tonalityLimit` is relative to the sample rate (8000 / 48000), 0 = off.
__attribute__((used)) void br_set_transpose(Instance *s, float semitones, float tonalityLimit) {
	s->stretch.setTransposeSemitones(semitones, tonalityLimit);
}

// `compensate` keeps the formants in place while the pitch moves; `base` is the rough
// fundamental relative to the sample rate (0 = estimate it).
__attribute__((used)) void br_set_formant(Instance *s, int compensate, float base) {
	s->stretch.setFormantSemitones(0, compensate != 0);
	s->stretch.setFormantBase(base);
}

__attribute__((used)) void br_reset(Instance *s) { s->stretch.reset(); }

// Pre-roll: the first `frames` of the input buffer, ending at the next input position.
__attribute__((used)) void br_seek(Instance *s, int frames, double playbackRate) {
	s->stretch.seek(s->inPtr, frames, playbackRate);
}

__attribute__((used)) void br_process(Instance *s, int inFrames, int outFrames) {
	s->stretch.process(s->inPtr, inFrames, s->outPtr, outFrames);
}

__attribute__((used)) void br_flush(Instance *s, int outFrames) {
	s->stretch.flush(s->outPtr, outFrames);
}

} // extern "C"
