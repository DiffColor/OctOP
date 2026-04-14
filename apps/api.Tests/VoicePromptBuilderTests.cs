using OctOP.Gateway.Voice;
using Xunit;

namespace OctOP.Gateway.Tests;

public sealed class VoicePromptBuilderTests
{
  [Fact]
  public void BuildInstructions_UsesVoiceRoleGuidanceAndTreatsProjectInstructionsAsOptionalMemos()
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

    Assert.Contains("[음성 세션 역할 지침]", instructions);
    Assert.Contains("당신은 OctOP의 실시간 음성 작업 비서입니다.", instructions);
    Assert.Contains("[프로젝트 컨텍스트]", instructions);
    Assert.Contains("[선택적 음성 선호 및 운영 메모]", instructions);
    Assert.Contains("[프로젝트 운영 메모]\n항상 한국어로 답변하고 결과부터 말합니다.", instructions);
    Assert.Contains("[프로젝트 작업 메모]\n변경 전에는 반드시 현재 코드를 다시 읽습니다.", instructions);
    Assert.Contains("[현재 쓰레드 메모]\n이번 채팅에서는 음성 첫 응답부터 지침을 적용합니다.", instructions);

    var roleIndex = instructions.IndexOf("[음성 세션 역할 지침]", StringComparison.Ordinal);
    var contextIndex = instructions.IndexOf("[프로젝트 컨텍스트]", StringComparison.Ordinal);

    Assert.True(roleIndex >= 0);
    Assert.True(contextIndex > roleIndex);
  }

  [Fact]
  public void BuildTranscriptionPrompt_IncludesCompressedVoiceMemoContext()
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

    Assert.Contains("음성 역할: 짧게 이해하고 app-server에 위임한 뒤 상태와 결과만 간단히 보고", prompt);
    Assert.Contains("음성 메모: 프로젝트 운영 메모 항상 한국어로 대답합니다. / 프로젝트 작업 메모 현재 시점 코드를 기준으로 판단합니다. / 현재 쓰레드 메모 첫 대화에서도 개발지침을 그대로 적용합니다.", prompt);
  }
}
