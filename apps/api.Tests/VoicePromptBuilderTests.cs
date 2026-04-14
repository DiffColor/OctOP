using OctOP.Gateway.Voice;
using Xunit;

namespace OctOP.Gateway.Tests;

public sealed class VoicePromptBuilderTests
{
  [Fact]
  public void BuildInstructions_PrioritizesBaseAndDeveloperInstructionsFromFirstTurn()
  {
    var builder = new VoicePromptBuilder();
    var request = new VoiceSessionStartRequest
    {
      ProjectName = "OctOP",
      ThreadTitle = "음성 채팅",
      ProjectBaseInstructions = "항상 한국어로 답변하고 결과부터 말합니다.",
      ProjectDeveloperInstructions = "변경 전에는 반드시 현재 코드를 다시 읽습니다.",
      ThreadDeveloperInstructions = "이번 채팅에서는 음성 첫 응답부터 지침을 적용합니다."
    };

    var instructions = builder.BuildInstructions(request);

    Assert.Contains("[세션 최우선 지침]", instructions);
    Assert.Contains("[기본지침]\n항상 한국어로 답변하고 결과부터 말합니다.", instructions);
    Assert.Contains("[개발지침]\n변경 전에는 반드시 현재 코드를 다시 읽습니다.\n\n이번 채팅에서는 음성 첫 응답부터 지침을 적용합니다.", instructions);

    var priorityIndex = instructions.IndexOf("[세션 최우선 지침]", StringComparison.Ordinal);
    var operationalIndex = instructions.IndexOf("초기 대화의 주도권은 현재 Realtime 세션이 가집니다.", StringComparison.Ordinal);

    Assert.True(priorityIndex >= 0);
    Assert.True(operationalIndex > priorityIndex);
  }

  [Fact]
  public void BuildTranscriptionPrompt_IncludesCompressedInstructionContext()
  {
    var builder = new VoicePromptBuilder();
    var request = new VoiceSessionStartRequest
    {
      ProjectName = "OctOP",
      ProjectBaseInstructions = "항상 한국어로 대답합니다.",
      ProjectDeveloperInstructions = "현재 시점 코드를 기준으로 판단합니다.",
      ThreadDeveloperInstructions = "첫 대화에서도 개발지침을 그대로 적용합니다."
    };

    var prompt = builder.BuildTranscriptionPrompt(request);

    Assert.Contains("기본지침: 항상 한국어로 대답합니다.", prompt);
    Assert.Contains("개발지침: 현재 시점 코드를 기준으로 판단합니다. 첫 대화에서도 개발지침을 그대로 적용합니다.", prompt);
  }
}
